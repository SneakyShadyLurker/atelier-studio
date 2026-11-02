import { Hono } from 'hono';
import { isVideoMime } from '@atelier/shared';
import type { CharacterCardErrorCode, CharacterCardSseEvent, EphemeraStatus } from '@atelier/shared';
import { ephemeraEnabled } from '../config';
import { withLlmSlot } from '../lifecycle/withLlmSlot';
import { enhancePool } from '../orchestrator/llmAdmission';
import { CHARACTER_CARD_MESSAGES, createCharacterFromImage } from '../providers/ephemera/client';
import type { AppEnv } from '../server-env';
import { StorageSealedError } from '../storage/crypto';
import { readArtifactBytes } from '../storage/files';
import { parseBody, parseParams } from './_http';
import { selectDoneTileWithPrompt } from '../db/doneTile';
import { ephemeraGate } from './ephemera.gate';
import { CharacterCardBodySchema, CharacterCardParamSchema } from './ephemera.schema';

const RETRY_AFTER_SECONDS = 10;

// Ephemera character cards (docs/providers.md § Ephemera character cards).
// Ephemera writes and saves the card; this route resolves the user's done
// image tile, forwards its bytes and prompt through the client, and relays
// phases plus exactly one terminal frame (none after a client disconnect).
// Logs carry ids, the card kind, status, code and duration only: never the
// card name, the prompt, the direction or an Ephemera body.
export const ephemeraRoutes = new Hono<AppEnv>()
  // Path-scoped gates: a `*` gate would also answer for routes mounted later.
  .use('/ephemera', ephemeraGate)
  .use('/tiles/:tileId/character-card', ephemeraGate)
  .get('/ephemera', (c) => {
    const config = c.var.config;
    if (!ephemeraEnabled(config)) return c.json({ error: 'not found' }, 404);
    const body: EphemeraStatus = { origin: config.EPHEMERA_ORIGIN, timeoutMs: config.EPHEMERA_CARD_TIMEOUT_MS };
    return c.json(body, 200, { 'Cache-Control': 'private, no-store' });
  })
  .post('/tiles/:tileId/character-card', async (c) => {
    const config = c.var.config;
    if (!ephemeraEnabled(config)) return c.json({ error: 'not found' }, 404);
    const params = parseParams(c, CharacterCardParamSchema);
    if (!params.ok) return params.response;
    const body = await parseBody(c, CharacterCardBodySchema);
    if (!body.ok) return body.response;
    const { tileId } = params.value;
    const { characterId, direction, kind } = body.value;
    const userId = c.var.userId;
    const tile = selectDoneTileWithPrompt(c.var.db, tileId, userId);
    if (!tile || isVideoMime(tile.mime)) return c.json({ error: 'not found' }, 404);
    const logger = c.var.logger;

    return withLlmSlot(c, enhancePool, userId, RETRY_AFTER_SECONDS, () => ({
      timeoutMs: config.EPHEMERA_CARD_TIMEOUT_MS,
      disconnect: c.req.raw.signal,
      run: async ({ send, signal, timedOut, clientDisconnected }) => {
        const startedAt = Date.now();
        const emit = (frame: CharacterCardSseEvent): void => { send(frame.event, frame.data); };
        const fail = (code: CharacterCardErrorCode, details: { status?: number; errorClass?: string } = {}): void => {
          logger.warn({ tileId, userId, kind, code, ...details, durationMs: Date.now() - startedAt }, 'ephemera_card_failed');
          emit({ event: 'error', data: { message: CHARACTER_CARD_MESSAGES[code], code } });
        };
        // Lifecycle wins over every error class: a disconnect stays silent and
        // Atelier's deadline is `timeout`, whatever the failing call threw.
        const lifecycleEnded = (): boolean => {
          if (clientDisconnected()) {
            logger.info({ tileId, userId, kind, durationMs: Date.now() - startedAt }, 'ephemera_card_disconnected');
            return true;
          }
          if (timedOut()) {
            fail('timeout');
            return true;
          }
          return false;
        };

        try {
          emit({ event: 'status', data: { phase: 'reading' } });
          const artifact = await readArtifactBytes(
            config.DATA_DIR,
            'images',
            userId,
            tileId,
            tile.ext,
            tile.mime,
            { signal },
          );
          // null means the file is gone (a sealed store throws instead).
          if (!artifact) {
            if (!lifecycleEnded()) fail('image-unavailable', { errorClass: 'ArtifactMissing' });
            return;
          }
          const outcome = await createCharacterFromImage(
            config,
            {
              userId,
              characterId,
              image: { bytes: artifact.bytes, mime: artifact.mime, filename: `${tileId}.${artifact.ext}` },
              notes: tile.prompt,
              direction: direction ?? null,
              kind,
            },
            signal,
            (phase) => { emit({ event: 'status', data: { phase } }); },
          );
          if (outcome.ok) {
            logger.info({ tileId, userId, kind, status: 200, durationMs: Date.now() - startedAt }, 'ephemera_card_saved');
            emit({
              event: 'result',
              data: { characterId: outcome.characterId, name: outcome.name, url: outcome.url },
            });
            return;
          }
          if (lifecycleEnded()) return;
          fail(outcome.code, outcome.status === undefined ? {} : { status: outcome.status });
        } catch (error) {
          if (lifecycleEnded()) return;
          if (error instanceof StorageSealedError) {
            fail('storage-sealed');
            return;
          }
          fail('card-failed', { errorClass: error instanceof Error ? error.name : typeof error });
        }
      },
    }));
  });
