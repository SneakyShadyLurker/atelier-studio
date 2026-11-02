import { z } from 'zod';
import { CHARACTER_CARD_DIRECTION_MAX_CHARS, CHARACTER_CARD_KINDS } from '@atelier/shared';
import { maxUtf16Length } from '../validation/stringLength';
import { uuidParam } from './_schema';

export const CharacterCardParamSchema = uuidParam('tileId');

// `characterId` is the web's operation id for this tile: it is reused until a
// request ends with `result`, so a retry after a lost result or an ambiguous
// failure resolves to the character Ephemera already kept instead of a
// duplicate. `direction` is the user's optional steering text; blank after
// trimming means none. `kind` picks the card Ephemera writes; absent means
// `subject`, so an older cached web build keeps working.
export const CharacterCardBodySchema = z.object({
  characterId: z.uuid(),
  direction: z.string().trim().check(maxUtf16Length(CHARACTER_CARD_DIRECTION_MAX_CHARS)).optional(),
  kind: z.enum(CHARACTER_CARD_KINDS).default('subject'),
});
