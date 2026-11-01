#!/bin/bash
set -euo pipefail

WORKSPACE="/home/agent/workspace"

CHECKPOINT_INTERVAL_MS="${AGENT_CHECKPOINT_INTERVAL_MS:-0}"
CHECKPOINTS_ENABLED=0
HAS_WIP_FILE="/tmp/ao_has_wip"
CHECKPOINT_PID=""
rm -f "$HAS_WIP_FILE" 2>/dev/null || true
if [ "${AGENT_MODE:-}" = "dev" ] && [ "$CHECKPOINT_INTERVAL_MS" -gt 0 ] 2>/dev/null; then
  CHECKPOINTS_ENABLED=1
fi

configure_github_auth() {
  local token_file="/run/secrets/github_push_token"

  if [ ! -f "$token_file" ]; then
    return 1
  fi

  local github_token
  github_token=$(tr -d '\r\n' < "$token_file")

  if [ -z "$github_token" ]; then
    return 1
  fi

  local github_auth_b64
  github_auth_b64=$(printf "x-access-token:%s" "$github_token" | base64 | tr -d '\n')
  git config --global http.https://github.com/.extraheader "AUTHORIZATION: basic $github_auth_b64"
  return 0
}

clear_github_auth() {
  git config --global --unset-all http.https://github.com/.extraheader 2>/dev/null || true
}

do_checkpoint() {
  cd "$WORKSPACE" 2>/dev/null || return 0

  git add -A -- ':(exclude)AGENTS.md' 2>/dev/null || git add -A 2>/dev/null || return 0

  if git diff --cached --quiet 2>/dev/null; then
    return 0
  fi

  if [ -f "$HAS_WIP_FILE" ]; then
    git commit --amend --no-edit --quiet 2>/dev/null || return 0
  else
    git commit -m "${COMMIT_MESSAGE:-wip: checkpoint}" --quiet 2>/dev/null || return 0
    touch "$HAS_WIP_FILE"
  fi

  if [ "$REPO_URL" = "local" ]; then
    echo "::checkpoint::committed"
    return 0
  fi

  if configure_github_auth 2>/dev/null; then
    if git push --force-with-lease -u origin "$BRANCH" --quiet 2>/dev/null; then
      echo "::checkpoint::pushed"
    fi
    clear_github_auth 2>/dev/null || true
  fi
  return 0
}

start_checkpoint_loop() {
  [ "$CHECKPOINTS_ENABLED" = "1" ] || return 0

  local interval_s=$(( CHECKPOINT_INTERVAL_MS / 1000 ))
  [ "$interval_s" -lt 15 ] && interval_s=15

  (
    while true; do
      sleep "$interval_s"
      do_checkpoint || true
    done
  ) &
  CHECKPOINT_PID=$!
  echo "::checkpoint::enabled (every ${interval_s}s)"
}

stop_checkpoint_loop() {
  if [ -n "$CHECKPOINT_PID" ]; then
    pkill -P "$CHECKPOINT_PID" 2>/dev/null || true
    kill "$CHECKPOINT_PID" 2>/dev/null || true
    wait "$CHECKPOINT_PID" 2>/dev/null || true
    CHECKPOINT_PID=""
    rm -f "$WORKSPACE/.git/index.lock" 2>/dev/null || true
  fi
}

copy_local_workspace_if_needed() {
  if [ "${LOCAL_SOURCE_MODE:-}" != "copy" ] || [ -z "${LOCAL_SOURCE_WORKSPACE:-}" ]; then
    return
  fi

  rm -rf "$WORKSPACE"
  mkdir -p "$WORKSPACE"

  local excludes_raw="${LOCAL_SOURCE_EXCLUDES:-data .git node_modules dist .next .docker-agent-tmp .bun-cache .npm-cache .yarn-cache .env .env.*}"
  local -a excludes
  read -ra excludes <<< "$excludes_raw"

  shopt -s dotglob nullglob
  local entry base skip ex
  for entry in "$LOCAL_SOURCE_WORKSPACE"/*; do
    base="$(basename "$entry")"
    skip=0
    for ex in "${excludes[@]}"; do
      # shellcheck disable=SC2254 — intentional glob match against $ex
      case "$base" in
        $ex) skip=1; break ;;
      esac
    done
    [ "$skip" -eq 1 ] && continue
    cp -a "$entry" "$WORKSPACE"/ 2>/dev/null \
      || echo "::warn::Skipped partially unreadable entry: $base" >&2
  done
  shopt -u dotglob nullglob
}

configure_opencode_auth() {
  local src="/run/secrets/opencode_auth.json"
  local dest="${OPENCODE_AUTH_DEST:-}"

  if [ -z "$dest" ] || [ ! -f "$src" ]; then
    return 0
  fi

  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  chmod 600 "$dest"
}

copy_local_workspace_if_needed
configure_opencode_auth

if [ -n "${PROMPT_FILE:-}" ] && [ -f "$PROMPT_FILE" ]; then
  PROMPT=$(cat "$PROMPT_FILE")
fi

if [ -z "${PROMPT:-}" ]; then
  echo "::error::No prompt provided (set PROMPT or PROMPT_FILE)" >&2
  exit 1
fi

mkdir -p "$WORKSPACE"
git config --global --add safe.directory "$WORKSPACE"

if [ "$REPO_URL" = "local" ]; then
  echo "::clone::Using local workspace..."
  cd "$WORKSPACE"

  if [ ! -d .git ]; then
    git init --initial-branch "$BASE_BRANCH"
    git config user.name "${GIT_USER_NAME:-AI Office Agent}"
    git config user.email "${GIT_USER_EMAIL:-agent@local}"
    git commit --allow-empty -m "chore: initialize local project"
  fi

  git config user.name "${GIT_USER_NAME:-AI Office Agent}"
  git config user.email "${GIT_USER_EMAIL:-agent@local}"
  git checkout "$BASE_BRANCH" 2>/dev/null || git checkout -B "$BASE_BRANCH"

  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git checkout "$BRANCH"
  else
    git checkout -b "$BRANCH"
  fi
else
  echo "::clone::Cloning $REPO_URL..."
  configure_github_auth || true
  git clone --config core.hooksPath=/dev/null "$REPO_URL" "$WORKSPACE"
  cd "$WORKSPACE"

  git fetch origin
  git checkout "$BASE_BRANCH"
  git pull origin "$BASE_BRANCH"

  if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
    echo "::checkout::Reusing existing remote branch $BRANCH"
    git fetch origin "$BRANCH"
    git checkout -B "$BRANCH" "origin/$BRANCH"
    git branch --set-upstream-to="origin/$BRANCH" "$BRANCH" 2>/dev/null || true
  else
    echo "::checkout::Creating branch $BRANCH from $BASE_BRANCH"
    git checkout -B "$BRANCH" "$BASE_BRANCH"
  fi
  clear_github_auth
fi

if [ -n "${SYSTEM_PROMPT_FILE:-}" ] && [ -f "$SYSTEM_PROMPT_FILE" ]; then
  cp "$SYSTEM_PROMPT_FILE" "$WORKSPACE/AGENTS.md"
  echo "::agents_md::Written AGENTS.md from SYSTEM_PROMPT_FILE"
fi

mkdir -p "$WORKSPACE/.git/info"
cat << 'EOF' >> "$WORKSPACE/.git/info/exclude"
.npm-cache
.yarn-cache
.bun-cache
EOF

export NPM_CONFIG_CACHE="$WORKSPACE/.npm-cache"
export YARN_CACHE_FOLDER="$WORKSPACE/.yarn-cache"
export BUN_INSTALL_CACHE_DIR="$WORKSPACE/.bun-cache"

mkdir -p "$WORKSPACE/.opencode"
cat << 'OCEOF' > "$WORKSPACE/.opencode/opencode.json"
{
  "tools": {
    "webfetch": false,
    "websearch": false,
    "lsp": false,
    "skill": false,
    "task": false,
    "mcp": false
  }
}
OCEOF

echo ".opencode" >> "$WORKSPACE/.git/info/exclude"

if [ "$CHECKPOINTS_ENABLED" = "1" ]; then
  if [ "$REPO_URL" = "local" ]; then
    AHEAD_AT_START=$(git rev-list --count "$BASE_BRANCH..HEAD" 2>/dev/null || echo 0)
  else
    AHEAD_AT_START=$(git rev-list --count "origin/$BASE_BRANCH..HEAD" 2>/dev/null || echo 0)
  fi
  if [ "${AHEAD_AT_START:-0}" -gt 0 ] 2>/dev/null; then
    touch "$HAS_WIP_FILE"
    echo "::checkpoint::resuming existing branch work (${AHEAD_AT_START} commit(s))"
  fi
fi

trap stop_checkpoint_loop EXIT
start_checkpoint_loop

echo "::opencode::Running opencode (mode=$AGENT_MODE, model=$MODEL)..."
opencode run --model "$MODEL" --dir . "$PROMPT" 2>&1
OPENCODE_EXIT=$?

if [ $OPENCODE_EXIT -ne 0 ]; then
  echo "::error::opencode exited with code $OPENCODE_EXIT"
  exit $OPENCODE_EXIT
fi

if [ -f "$WORKSPACE/AGENTS.md" ]; then
  rm -f "$WORKSPACE/AGENTS.md"
  git checkout -- AGENTS.md 2>/dev/null || true
fi

if [ "$AGENT_MODE" = "dev" ]; then
  stop_checkpoint_loop

  if ! git config --get user.name >/dev/null; then
    git config user.name "${GIT_USER_NAME:-AI Office Agent}"
  fi
  if ! git config --get user.email >/dev/null; then
    git config user.email "${GIT_USER_EMAIL:-agent@local}"
  fi

  if [ "$CHECKPOINTS_ENABLED" = "1" ]; then
    git add -A
    if ! git diff --cached --quiet; then
      if [ -f "$HAS_WIP_FILE" ]; then
        git commit --amend --no-edit
      else
        git commit -m "${COMMIT_MESSAGE:-feat: automated changes}"
        touch "$HAS_WIP_FILE"
      fi
    fi

    if [ "$REPO_URL" = "local" ]; then
      AHEAD=$(git rev-list --count "$BASE_BRANCH..HEAD" 2>/dev/null || echo 0)
      if [ "$AHEAD" -gt 0 ]; then
        echo "::result::commits_available"
      else
        echo "::result::no_changes"
      fi
    else
      AHEAD=$(git rev-list --count "origin/$BASE_BRANCH..HEAD" 2>/dev/null || echo 0)
      if [ "$AHEAD" -gt 0 ]; then
        configure_github_auth || {
          echo "::error::GitHub push credential is not available" >&2
          exit 1
        }
        git push --force-with-lease -u origin "$BRANCH"
        clear_github_auth
        echo "::result::commits_pushed"
      else
        echo "::result::no_changes"
      fi
    fi
  else
    PORCELAIN=$(git status --porcelain)

    if [ -n "$PORCELAIN" ]; then
      git add .
      git commit -m "${COMMIT_MESSAGE:-feat: automated changes}"
      if [ "$REPO_URL" = "local" ]; then
        echo "::result::changes_committed"
      else
        configure_github_auth || {
          echo "::error::GitHub push credential is not available" >&2
          exit 1
        }
        git push -u origin "$BRANCH"
        clear_github_auth
        echo "::result::changes_pushed"
      fi
    else
      if [ "$REPO_URL" = "local" ]; then
        AHEAD=$(git rev-list --count "$BASE_BRANCH..HEAD" 2>/dev/null || echo 0)
      else
        AHEAD=$(git rev-list --count "origin/$BASE_BRANCH..HEAD" 2>/dev/null || echo 0)
      fi

      if [ "$AHEAD" -gt 0 ]; then
        if [ "$REPO_URL" = "local" ]; then
          echo "::result::commits_available"
        else
          configure_github_auth || {
            echo "::error::GitHub push credential is not available" >&2
            exit 1
          }
          git push -u origin "$BRANCH"
          clear_github_auth
          echo "::result::commits_pushed"
        fi
      else
        echo "::result::no_changes"
      fi
    fi
  fi
fi

echo "::done::"
