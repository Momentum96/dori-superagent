#!/usr/bin/env bash
# Installs the dori-mode skill and the `dori` CLI (the harness, which also runs Dori mode's commands).
# Usage: curl -fsSL https://raw.githubusercontent.com/sisyphuslabs/dori-superagent/main/install.sh | bash
# Needs: git, bun 1.3+. Optional env: DORI_SRC (clone dir), SKILLS_DIR (where your agent loads skills).
set -euo pipefail

repo="https://github.com/sisyphuslabs/dori-superagent.git"
src="${DORI_SRC:-$HOME/.dori/src}"
skills="${SKILLS_DIR:-$HOME/.agents/skills}"

command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }

if [ -d "$src/.git" ]; then git -C "$src" pull --ff-only --quiet; else git clone --quiet --depth 1 "$repo" "$src"; fi

mkdir -p "$skills"
if [ -e "$skills/dori-mode" ] && [ ! -L "$skills/dori-mode" ]; then
  echo "$skills/dori-mode exists and is not a link; leaving it alone" >&2
else
  ln -sfn "$src/skills/dori-mode" "$skills/dori-mode"
fi

(cd "$src/skills/dori-mode/scripts" && bun install --silent && bun link --silent)   # dori-mode
(cd "$src" && bun install --silent && bun link --silent)                              # dori

mkdir -p "$HOME/.dori"
[ -f "$HOME/.dori/config.json" ] || cp "$src/skills/dori-mode/references/config.example.json" "$HOME/.dori/config.json"

echo "Installed. Skill: $skills/dori-mode  CLI: dori  Config: ~/.dori/config.json"
echo "Next: edit ~/.dori/config.json, then tell your agent: Dori mode"
