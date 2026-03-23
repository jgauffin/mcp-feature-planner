#!/usr/bin/env bash
#
# Post-edit backwards compatibility checker for src/types.ts
# Compares the working copy of types.ts against the last committed version
# and flags potentially breaking changes to the JSON persistence layer.
#
set -euo pipefail

TYPES_FILE="src/types.ts"
YELLOW='\033[1;33m'
RED='\033[1;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Only run if types.ts was the file edited
if [[ "${CLAUDE_EDIT_FILE:-}" != *"types.ts" && "${1:-}" != "--force" ]]; then
  exit 0
fi

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  🔍 MODEL BACKWARDS COMPATIBILITY CHECK${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Get the diff (staged or unstaged)
DIFF=$(git diff HEAD -- "$TYPES_FILE" 2>/dev/null || git diff -- "$TYPES_FILE" 2>/dev/null || echo "")

if [ -z "$DIFF" ]; then
  echo -e "${GREEN}  ✅ No uncommitted changes to types.ts${NC}"
  exit 0
fi

BREAKING=0
WARNINGS=0
SAFE=0

# --- Check for removed interface fields (lines starting with - that contain field: type patterns) ---
REMOVED_FIELDS=$(echo "$DIFF" | grep -E '^\-\s+\w+(\?)?:\s' | grep -v '^\-\-\-' || true)
if [ -n "$REMOVED_FIELDS" ]; then
  echo ""
  echo -e "${RED}  🚨 BREAKING: Removed or renamed fields detected:${NC}"
  echo "$REMOVED_FIELDS" | while IFS= read -r line; do
    echo -e "     ${RED}$line${NC}"
  done
  echo ""
  echo -e "     ${YELLOW}Impact: Existing sessions in data/sessions.json still have these fields."
  echo -e "     The load() method in session-store.ts will create objects missing these"
  echo -e "     fields, or with stale field names. Any code referencing removed fields"
  echo -e "     will get 'undefined' at runtime.${NC}"
  BREAKING=$((BREAKING + 1))
fi

# --- Check for added required fields (no ? modifier) ---
ADDED_REQUIRED=$(echo "$DIFF" | grep -E '^\+\s+\w+:\s' | grep -v '^\+\+\+' | grep -v '?\s*:' || true)
if [ -n "$ADDED_REQUIRED" ]; then
  echo ""
  echo -e "${RED}  🚨 BREAKING: New required fields added:${NC}"
  echo "$ADDED_REQUIRED" | while IFS= read -r line; do
    echo -e "     ${RED}$line${NC}"
  done
  echo ""
  echo -e "     ${YELLOW}Impact: Existing sessions loaded from data/sessions.json won't have"
  echo -e "     these fields. TypeScript won't catch this — the JSON is parsed as 'any'."
  echo -e "     Code expecting these fields will get 'undefined' at runtime.${NC}"
  BREAKING=$((BREAKING + 1))
fi

# --- Check for added optional fields (has ? modifier) ---
ADDED_OPTIONAL=$(echo "$DIFF" | grep -E '^\+\s+\w+\?:\s' | grep -v '^\+\+\+' || true)
if [ -n "$ADDED_OPTIONAL" ]; then
  echo ""
  echo -e "${GREEN}  ✅ SAFE: New optional fields added:${NC}"
  echo "$ADDED_OPTIONAL" | while IFS= read -r line; do
    echo -e "     ${GREEN}$line${NC}"
  done
  echo ""
  echo -e "     ${GREEN}These are backwards compatible — old sessions simply won't have them.${NC}"
  SAFE=$((SAFE + 1))
fi

# --- Check for type changes on existing fields ---
CHANGED_TYPES=$(echo "$DIFF" | grep -E '^[\-\+]\s+\w+(\?)?:\s' | grep -v '^\-\-\-' | grep -v '^\+\+\+' || true)
# If we have both additions and removals for the same field name, it might be a type change
if [ -n "$CHANGED_TYPES" ]; then
  REMOVED_NAMES=$(echo "$DIFF" | grep -E '^\-\s+(\w+)(\?)?:' | grep -v '^\-\-\-' | sed -E 's/^\-\s+(\w+)(\?)?.*/\1/' || true)
  ADDED_NAMES=$(echo "$DIFF" | grep -E '^\+\s+(\w+)(\?)?:' | grep -v '^\+\+\+' | sed -E 's/^\+\s+(\w+)(\?)?.*/\1/' || true)

  if [ -n "$REMOVED_NAMES" ] && [ -n "$ADDED_NAMES" ]; then
    RENAMED=$(comm -12 <(echo "$REMOVED_NAMES" | sort) <(echo "$ADDED_NAMES" | sort) 2>/dev/null || true)
    if [ -n "$RENAMED" ]; then
      echo ""
      echo -e "${YELLOW}  ⚠️  WARNING: Fields with changed types:${NC}"
      echo "$RENAMED" | while IFS= read -r field; do
        OLD_TYPE=$(echo "$DIFF" | grep -E "^\-\s+${field}(\?)?\s*:" | head -1 || true)
        NEW_TYPE=$(echo "$DIFF" | grep -E "^\+\s+${field}(\?)?\s*:" | head -1 || true)
        echo -e "     ${YELLOW}$field:${NC}"
        echo -e "       Old: ${RED}$OLD_TYPE${NC}"
        echo -e "       New: ${GREEN}$NEW_TYPE${NC}"
      done
      WARNINGS=$((WARNINGS + 1))
    fi
  fi
fi

# --- Check for changes to union types (Phase, etc.) ---
UNION_CHANGES=$(echo "$DIFF" | grep -E "^[\-\+].*type\s+\w+\s*=" | grep -v '^\-\-\-' | grep -v '^\+\+\+' || true)
if [ -n "$UNION_CHANGES" ]; then
  echo ""
  echo -e "${YELLOW}  ⚠️  WARNING: Union type definition changed:${NC}"
  echo "$UNION_CHANGES" | while IFS= read -r line; do
    echo -e "     ${YELLOW}$line${NC}"
  done
  echo ""
  echo -e "     ${YELLOW}Impact: If union values were removed or renamed, existing sessions"
  echo -e "     may contain values that are no longer valid.${NC}"
  WARNINGS=$((WARNINGS + 1))
fi

# --- Check for renamed interfaces ---
REMOVED_INTERFACES=$(echo "$DIFF" | grep -E '^\-export\s+interface\s+\w+' | grep -v '^\-\-\-' || true)
if [ -n "$REMOVED_INTERFACES" ]; then
  echo ""
  echo -e "${RED}  🚨 BREAKING: Interface removed or renamed:${NC}"
  echo "$REMOVED_INTERFACES" | while IFS= read -r line; do
    echo -e "     ${RED}$line${NC}"
  done
  BREAKING=$((BREAKING + 1))
fi

# --- Summary ---
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  Summary: ${RED}${BREAKING} breaking${NC} | ${YELLOW}${WARNINGS} warnings${NC} | ${GREEN}${SAFE} safe${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [ "$BREAKING" -gt 0 ]; then
  echo ""
  echo -e "${RED}${BOLD}  ❌ BREAKING CHANGES DETECTED — MIGRATION REQUIRED${NC}"
  echo ""
  echo -e "  ${BOLD}You MUST update session-store.ts before committing:${NC}"
  echo ""
  echo -e "  1. Update the ${BOLD}load()${NC} method to handle old session format:"
  echo -e "     - Add default values for new required fields"
  echo -e "     - Map renamed fields from old names"
  echo -e "     - Remove/ignore deprecated fields"
  echo ""
  echo -e "  2. Example migration in load():"
  echo -e "     ${CYAN}for (const s of list) {"
  echo -e "       // Migration: add default for new required field"
  echo -e "       if (!s.newField) s.newField = 'default';"
  echo -e "       // Migration: rename old field"
  echo -e "       if (s.oldName) { s.newName = s.oldName; delete s.oldName; }"
  echo -e "     }${NC}"
  echo ""
  echo -e "  3. Consider adding a ${BOLD}schemaVersion${NC} field to Session"
  echo -e "     to make future migrations easier."
  echo ""
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  exit 1
fi

if [ "$WARNINGS" -gt 0 ]; then
  echo ""
  echo -e "${YELLOW}  ⚠️  Review the warnings above before proceeding.${NC}"
  echo -e "${YELLOW}  Consider testing with an existing data/sessions.json file.${NC}"
  echo ""
fi

exit 0
