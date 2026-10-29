#!/usr/bin/env bash
# Sourceable under bash 3.2, including callers using set -Eeuo pipefail.
DEPLOY_LOCK_START_TOLERANCE_SECONDS=2
DEPLOY_LOCK_ACQUIRE_GRACE_SECONDS=60
DEPLOY_LOCK_GUARD_WAIT_SECONDS="${DEPLOY_LOCK_GUARD_WAIT_SECONDS:-10}"
DEPLOY_LOCK_BOOT_MARGIN_SECONDS=60
deploy_lock_ps_missing=0
command -v ps >/dev/null || deploy_lock_ps_missing=1
# FD 7 belongs to this library; callers reserve FD 9 for their own lock.
deploy_lock_guard_tool=""
if [ -x /usr/bin/lockf ]; then
  deploy_lock_guard_tool=lockf
elif command -v flock >/dev/null 2>&1; then
  deploy_lock_guard_tool=flock
fi
deploy_lock_held=0
deploy_lock_inode=""
deploy_lock_path=""
deploy_lock_guard_held=0

# BSD stat takes -f <format>; GNU stat takes -c <format> and treats -f as a
# filesystem query that succeeds with a non-numeric answer, so probe the flavour
# instead of chaining the two on exit status.
deploy_lock_stat() {
  local value
  if stat -c %i / >/dev/null 2>&1; then
    value="$(stat -c "$2" "$3" 2>/dev/null)" || return 1
  else
    value="$(stat -f "$1" "$3" 2>/dev/null)" || return 1
  fi
  case "$value" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$value"
}

deploy_lock_boot() {
  local value
  value="$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*sec = \([0-9][0-9]*\),.*/\1/p')" || value=""
  if [ -z "$value" ] && [ -r /proc/stat ]; then
    value="$(awk '$1 == "btime" {print $2}' /proc/stat)" || value=""
  fi
  case "$value" in *[!0-9]*) value="" ;; esac
  printf '%s\n' "$value"
}

deploy_lock_ps() {
  local value status=0
  [ "$deploy_lock_ps_missing" -eq 0 ] || return 2
  value="$(LC_ALL=C TZ=UTC ps -o "$1=" -p "$2" 2>/dev/null)" || status=$?
  # Trim only the edges: lstart's internal spacing is part of its identity.
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [ "$status" -eq 0 ] && [ -n "$value" ]; then
    printf '%s\n' "$value"
    return 0
  fi
  [ "$status" -eq 1 ] && [ -z "$value" ] && return 1
  return 2
}

deploy_lock_start_epoch() {
  local elapsed now days=0 hours=0 minutes seconds
  now="$(date +%s)" || return 1
  elapsed="$(deploy_lock_ps etime "$1")" || return 1
  if [[ "$elapsed" =~ ^([0-9]+)-([0-9]+):([0-9]+):([0-9]+)$ ]]; then
    days=$((10#${BASH_REMATCH[1]}))
    hours=$((10#${BASH_REMATCH[2]}))
    minutes=$((10#${BASH_REMATCH[3]}))
    seconds=$((10#${BASH_REMATCH[4]}))
  elif [[ "$elapsed" =~ ^([0-9]+):([0-9]+):([0-9]+)$ ]]; then
    hours=$((10#${BASH_REMATCH[1]}))
    minutes=$((10#${BASH_REMATCH[2]}))
    seconds=$((10#${BASH_REMATCH[3]}))
  elif [[ "$elapsed" =~ ^([0-9]+):([0-9]+)$ ]]; then
    minutes=$((10#${BASH_REMATCH[1]}))
    seconds=$((10#${BASH_REMATCH[2]}))
  else
    return 1
  fi
  printf '%s\n' "$((now - days * 86400 - hours * 3600 - minutes * 60 - seconds))"
}

# Results are globals so callers can retain the explanation without subshells.
deploy_lock_classify() {
  local dir="$1" pid="" boot="" start="" current_boot current_start
  local line key value seen_pid=0 seen_boot=0 seen_start=0 record recorded_at epoch age
  local status=0 owner_pid
  deploy_lock_kind=unreadable
  deploy_lock_reason="unreadable ownership record at $dir; refusing recovery"
  if [ ! -e "$dir" ]; then
    deploy_lock_kind=absent; deploy_lock_reason="lock absent at $dir"
    return 0
  fi
  if [ -e "$dir/owner" ]; then
    [ -f "$dir/owner" ] && [ -r "$dir/owner" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in *=*) ;; *) return 0 ;; esac
      key="${line%%=*}"
      value="${line#*=}"
      case "$key" in
        pid) [ "$seen_pid" -eq 0 ] || return 0; pid="$value"; seen_pid=1 ;;
        boot) [ "$seen_boot" -eq 0 ] || return 0; boot="$value"; seen_boot=1 ;;
        start) [ "$seen_start" -eq 0 ] || return 0; start="$value"; seen_start=1 ;;
        *) return 0 ;;
      esac
    done < "$dir/owner"
    [ "$seen_pid$seen_boot$seen_start" = 111 ] && [ -n "$start" ] || return 0
    case "$pid" in ''|*[!0-9]*) return 0 ;; esac
    case "$boot" in *[!0-9]*) return 0 ;; esac
    current_start="$(deploy_lock_ps lstart "$pid")" || status=$?
    [ "$status" -ne 2 ] || return 0
    if [ "$status" -eq 0 ] && [ "$current_start" = "$start" ]; then
      deploy_lock_kind=live-deploy; deploy_lock_reason="live deploy owner (PID $pid)"
      return 0
    fi
    deploy_lock_kind=stale
    current_boot="$(deploy_lock_boot)"
    if [ -n "$boot" ] && [ -n "$current_boot" ] && [ "$boot" != "$current_boot" ]; then
      deploy_lock_kind=stale; deploy_lock_reason="lock predates reboot"
    elif [ "$status" -eq 1 ]; then
      deploy_lock_reason="deploy owner dead (PID $pid)"
    else
      deploy_lock_reason="deploy PID reuse (PID $pid)"
    fi
    if [ -e "$dir/child" ]; then
      owner_pid="$pid"
      record="$deploy_lock_reason"
      deploy_lock_kind=unreadable
      deploy_lock_reason="unreadable child record at $dir; refusing recovery"
      [ -f "$dir/child" ] && [ -r "$dir/child" ] || return 0
      pid=""; start=""; seen_pid=0; seen_start=0
      while IFS= read -r line || [ -n "$line" ]; do
        key="${line%%=*}"; value="${line#*=}"
        case "$key" in
          pid) [ "$seen_pid" -eq 0 ] || return 0; pid="$value"; seen_pid=1 ;;
          start) [ "$seen_start" -eq 0 ] || return 0; start="$value"; seen_start=1 ;;
          *) return 0 ;;
        esac
      done < "$dir/child"
      [ "$seen_pid$seen_start" = 11 ] && [ -n "$start" ] || return 0
      case "$pid" in ''|*[!0-9]*) return 0 ;; esac
      status=0
      current_start="$(deploy_lock_ps lstart "$pid")" || status=$?
      [ "$status" -ne 2 ] || return 0
      if [ "$status" -eq 0 ] && [ "$current_start" = "$start" ]; then
        deploy_lock_kind=live-child
        deploy_lock_reason="deploy PID $owner_pid is gone but its child PID $pid is still running; wait for it to finish or stop it, then rerun"
      else
        deploy_lock_kind=stale; deploy_lock_reason="$record"
      fi
    fi
  elif [ -e "$dir/maintenance-pid" ] || [ -e "$dir/pid" ]; then
    record="$dir/pid"
    deploy_lock_reason="live PID owner"
    deploy_lock_kind=live-pid
    if [ -e "$dir/maintenance-pid" ]; then
      record="$dir/maintenance-pid"
      deploy_lock_reason="host maintenance is running"
      deploy_lock_kind=live-maintenance
    fi
    pid="$(cat "$record" 2>/dev/null)" || pid=""
    case "$pid" in ''|*[!0-9]*)
      deploy_lock_kind=unreadable; deploy_lock_reason="unreadable PID at $record; refusing recovery"; return 0 ;;
    esac
    recorded_at="$(deploy_lock_stat %m %Y "$record")" || {
      deploy_lock_kind=unreadable; deploy_lock_reason="unreadable mtime at $record"; return 0;
    }
    current_start="$(deploy_lock_ps lstart "$pid")" || status=$?
    if [ "$status" -eq 2 ]; then
      deploy_lock_kind=unreadable; deploy_lock_reason="unreadable process identity for PID $pid"
    elif [ "$status" -eq 1 ]; then
      deploy_lock_kind=stale; deploy_lock_reason="owner dead (PID $pid)"
    elif epoch="$(deploy_lock_start_epoch "$pid")"; then
      if [ "$epoch" -gt "$((recorded_at + DEPLOY_LOCK_START_TOLERANCE_SECONDS))" ]; then
        deploy_lock_kind=stale; deploy_lock_reason="PID reuse (PID $pid started after its record)"
      fi
    else
      deploy_lock_kind=unreadable; deploy_lock_reason="unreadable process elapsed time for PID $pid"
    fi
    if [ "$deploy_lock_kind" = stale ]; then
      current_boot="$(deploy_lock_boot)"
      if [ -n "$current_boot" ] && [ "$recorded_at" -lt "$current_boot" ]; then
        deploy_lock_reason="$deploy_lock_reason; lock predates reboot"
      fi
    fi
  else
    current_boot="$(deploy_lock_boot)"
    recorded_at="$(deploy_lock_stat %m %Y "$dir")" || return 0
    age=$(($(date +%s) - recorded_at))
    if [ -n "$current_boot" ] && [ "$recorded_at" -le "$((current_boot - DEPLOY_LOCK_BOOT_MARGIN_SECONDS))" ]; then
      deploy_lock_kind=stale; deploy_lock_reason="ownerless lock predates reboot"
    elif [ "$age" -lt "${deploy_lock_grace:-$DEPLOY_LOCK_ACQUIRE_GRACE_SECONDS}" ]; then
      deploy_lock_kind=acquiring; deploy_lock_reason="acquiring lock at $dir (${age}s old)"
    else
      deploy_lock_kind=ownerless
      deploy_lock_reason="ownerless lock at $dir (${age}s old); operator must first confirm no deploy or maintenance is running, then use --reclaim-ownerless-lock"
    fi
  fi
  return 0
}

deploy_lock_write_owner() {
  local dir="$1" start boot
  start="$(deploy_lock_ps lstart "$$")" || return 1
  [ -n "$start" ] || return 1
  boot="$(deploy_lock_boot)"
  printf 'pid=%s\nboot=%s\nstart=%s\n' "$$" "$boot" "$start" > "$dir/owner.$$.tmp" || return 1
  mv -f "$dir/owner.$$.tmp" "$dir/owner" || return 1
  return 0
}

deploy_lock_publish() {
  deploy_lock_inode="$(deploy_lock_stat %i %i "$deploy_lock_path")" || return 1
  deploy_lock_write_owner "$deploy_lock_path" || return 1
  printf '%s\n' "$$" > "$deploy_lock_path/pid" || return 1
  return 0
}

deploy_lock_track_child() {
  local pid="$1" start status=0
  [ "$deploy_lock_held" -eq 1 ] || return 0
  [ -n "$deploy_lock_inode" ] && [ "$(deploy_lock_stat %i %i "$deploy_lock_path" || true)" = "$deploy_lock_inode" ] || return 0
  if [ -z "$pid" ]; then
    rm -f "$deploy_lock_path/child" || return 1
    return 0
  fi
  start="$(deploy_lock_ps lstart "$pid")" || status=$?
  # A short-lived child may have exited before ps; the caller still reaps it.
  [ "$status" -ne 1 ] || return 0
  [ "$status" -eq 0 ] || return 1
  printf 'pid=%s\nstart=%s\n' "$pid" "$start" > "$deploy_lock_path/child.$pid.tmp" || return 1
  mv -f "$deploy_lock_path/child.$pid.tmp" "$deploy_lock_path/child" || return 1
  return 0
}

deploy_lock_abort_publish() {
  rm -f "$deploy_lock_path/owner" "$deploy_lock_path/pid" "$deploy_lock_path/child" \
    "$deploy_lock_path"/owner.*.tmp "$deploy_lock_path"/child.*.tmp || true
  rmdir "$deploy_lock_path" 2>/dev/null || true
  deploy_lock_held=0
  return 0
}

deploy_lock_release_guard() {
  if [ "$deploy_lock_guard_held" -eq 1 ]; then
    exec 7>&-
    deploy_lock_guard_held=0
  fi
  return 0
}

deploy_lock_release() {
  local moved="$deploy_lock_path.released.$$.$RANDOM"
  if [ "$deploy_lock_held" -eq 1 ]; then
    if [ -n "$deploy_lock_inode" ] && [ "$(deploy_lock_stat %i %i "$deploy_lock_path" || true)" = "$deploy_lock_inode" ]; then
      if mv "$deploy_lock_path" "$moved"; then
        rm -r "$moved" || true
      fi
    else
      echo "warning: deploy lock was reclaimed from under this process: $deploy_lock_path" >&2
    fi
    deploy_lock_held=0
  fi
  deploy_lock_release_guard
  return 0
}

# Move before deletion, and verify identity at the destination, never rm -r
# the shared path. A competing stale-lock reclaimer may have replaced it.
deploy_lock_move_stale() {
  local path="$1" inode="$2" moved="$1.stale.$$.$RANDOM"
  if ! mv "$path" "$moved" 2>/dev/null; then
    [ ! -e "$path" ] && return 0
    echo "deploy already running: could not move $path; rerun" >&2
    return 1
  fi
  if [ "$(deploy_lock_stat %i %i "$moved" || true)" != "$inode" ]; then
    if [ ! -e "$path" ]; then mv "$moved" "$path" 2>/dev/null || true; fi
    echo "deploy already running: ownership changed while moving $path; rerun" >&2
    return 1
  fi
  rm -r "$moved" || return 1
  return 0
}

deploy_lock_guard_file() {
  case "$deploy_lock_path" in
    */*) printf '%s/.deploy-reclaim.flock\n' "${deploy_lock_path%/*}" ;;
    *) printf '.deploy-reclaim.flock\n' ;;
  esac
}

# Inode of the file open on FD 7. macOS reports fdesc's device for /dev/fd/N,
# so compare inodes only; -L follows Linux's /proc/self/fd symlink.
deploy_lock_guard_fd_inode() {
  local value
  if stat -c %i / >/dev/null 2>&1; then
    value="$(stat -L -c %i /dev/fd/7 2>/dev/null)" || return 1
  else
    value="$(stat -L -f %i /dev/fd/7 2>/dev/null)" || return 1
  fi
  case "$value" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$value"
}

# The reclaim guard is a kernel flock, released when every descriptor on it
# closes, so it can never go stale. Every child started while it is held
# inherits FD 7 and keeps it locked until that child exits: callers may run
# only short commands between take and release. The guard file is persistent
# and deliberately does not match `.deploy.lock*`; never delete it, or two
# processes can lock different inodes at the same path.
deploy_lock_take_guard() {
  local guard wait_seconds="$DEPLOY_LOCK_GUARD_WAIT_SECONDS" attempt status fd_inode path_inode
  guard="$(deploy_lock_guard_file)"
  if [ -z "$deploy_lock_guard_tool" ]; then
    echo "deploy already running: no flock/lockf available to guard stale-lock recovery; recover the lock manually" >&2
    return 1
  fi
  case "$wait_seconds" in ''|*[!0-9]*) wait_seconds=10 ;; esac
  for attempt in 1 2 3; do
    if ! { exec 7>>"$guard"; } 2>/dev/null; then
      echo "deploy already running: cannot open the reclaim guard $guard; it must be a regular file writable by $(id -un) (fix its owner or type; never delete it while a deploy may hold it)" >&2
      return 1
    fi
    status=0
    if [ "$deploy_lock_guard_tool" = lockf ]; then
      /usr/bin/lockf -s -t "$wait_seconds" 7 || status=$?
    else
      flock -w "$wait_seconds" 7 || status=$?
    fi
    if [ "$status" -ne 0 ]; then
      exec 7>&-
      if { [ "$deploy_lock_guard_tool" = lockf ] && [ "$status" -eq 75 ]; } || { [ "$deploy_lock_guard_tool" = flock ] && [ "$status" -eq 1 ]; }; then
        echo "deploy already running: another deploy is reclaiming the lock (reclaim guard $guard is held; lsof lists its holder)" >&2
      else
        echo "deploy already running: could not lock the reclaim guard $guard ($deploy_lock_guard_tool exited $status)" >&2
      fi
      return 1
    fi
    # A guard replaced after we opened it leaves our lock on an orphaned
    # inode that others no longer contend for; only the current file counts.
    fd_inode="$(deploy_lock_guard_fd_inode)" || fd_inode=""
    path_inode="$(deploy_lock_stat %i %i "$guard" || true)"
    if [ -n "$fd_inode" ] && [ "$fd_inode" = "$path_inode" ]; then
      deploy_lock_guard_held=1
      return 0
    fi
    exec 7>&-
  done
  echo "deploy already running: the reclaim guard $guard kept changing after $attempt attempts; rerun" >&2
  return 1
}

deploy_lock_reclaimable() {
  [ "$deploy_lock_kind" = stale ] || {
    [ "$deploy_lock_kind" = ownerless ] && [ "${deploy_lock_reclaim_ownerless:-0}" -eq 1 ];
  }
}

deploy_lock_acquire() {
  local inode reason current_inode attempt
  deploy_lock_path="$1"
  for attempt in 1 2 3; do
    if mkdir "$deploy_lock_path" 2>/dev/null && deploy_lock_held=1; then
      deploy_lock_publish || {
        deploy_lock_abort_publish
        echo "could not publish deploy lock owner" >&2; return 1;
      }
      return 0
    fi
    inode="$(deploy_lock_stat %i %i "$deploy_lock_path" || true)"
    deploy_lock_classify "$deploy_lock_path"
    [ "$deploy_lock_kind" != absent ] || continue
    if ! deploy_lock_reclaimable; then
      echo "deploy already running: $deploy_lock_reason" >&2
      return 1
    fi
    deploy_lock_take_guard || { deploy_lock_release_guard; return 1; }
    deploy_lock_classify "$deploy_lock_path"
    if [ "$deploy_lock_kind" = absent ]; then
      deploy_lock_release_guard
      continue
    fi
    current_inode="$(deploy_lock_stat %i %i "$deploy_lock_path" || true)"
    if ! deploy_lock_reclaimable || [ -z "$inode" ] || [ "$current_inode" != "$inode" ]; then
      echo "deploy already running: $deploy_lock_reason (ownership may have changed; rerun)" >&2
      deploy_lock_release_guard
      return 1
    fi
    reason="$deploy_lock_reason"
    if ! deploy_lock_move_stale "$deploy_lock_path" "$inode"; then
      deploy_lock_release_guard
      return 1
    fi
    if mkdir "$deploy_lock_path" 2>/dev/null && deploy_lock_held=1; then
      deploy_lock_publish || {
        deploy_lock_abort_publish
        deploy_lock_release_guard
        echo "could not publish deploy lock owner" >&2; return 1;
      }
      echo "reclaimed stale lock at $deploy_lock_path: $reason" >&2
      deploy_lock_release_guard
      return 0
    fi
    deploy_lock_release_guard
    deploy_lock_classify "$deploy_lock_path"
    [ "$deploy_lock_kind" != absent ] || continue
    echo "deploy already running: $deploy_lock_reason" >&2
    return 1
  done
  echo "deploy already running: lock unavailable or changed at $deploy_lock_path after $attempt attempts; rerun" >&2
  return 1
}
