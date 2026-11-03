#!/usr/bin/env bash
# Exercise scripts/check-commit-identity.sh in a throwaway repository: it must pass the repo's own
# identity and refuse a foreign author, committer, co-author, tagger and configured identity,
# including the Co-Authored-By trailer AI coding tools add.
set -uo pipefail

SRC="$(git rev-parse --show-toplevel)"
T="$(mktemp -d "${TMPDIR:-/tmp}/idtest.XXXX")"
trap 'rm -r "$T"' EXIT
git init -q "$T/repo"
cd "$T/repo" || exit 1
mkdir -p scripts .github
cp "$SRC/scripts/check-commit-identity.sh" scripts/
cp "$SRC/.github/commit-identities" .github/
S=scripts/check-commit-identity.sh
GOOD_NAME=0x43687269735079
GOOD_EMAIL=289092784+0x43687269735079@users.noreply.github.com
BAD="Someone Else <someone@example.invalid>"
fails=0

expect() { # expect <wanted exit> <label> <command...>
  local want="$1" label="$2"
  shift 2
  "$@" >/dev/null 2>"$T/err"
  local got=$?
  if [ "$got" = "$want" ]; then
    echo "ok    $label (exit $got)"
  else
    echo "FAIL  $label: wanted exit $want, got $got"
    cat "$T/err"
    fails=$((fails + 1))
  fi
}

good() {
  git -c user.name="$GOOD_NAME" -c user.email="$GOOD_EMAIL" \
    -c commit.gpgsign=false -c tag.gpgsign=false "$@"
}

git config user.name "$GOOD_NAME"
git config user.email "$GOOD_EMAIL"
expect 0 "repo identity configured" "$S" configured
good commit -q --allow-empty -m "start"
expect 0 "history made by the repo identity" "$S" range HEAD

git config user.email someone@example.invalid
expect 1 "foreign identity configured" "$S" configured
git config user.email "$GOOD_EMAIL"

good commit -q --allow-empty -m "fine"
expect 0 "new commit by the repo identity" "$S" unpublished

good commit -q --allow-empty --author="$BAD" -m "foreign author"
expect 1 "foreign author in an unpublished commit" "$S" unpublished
git reset -q --hard HEAD~1

git -c user.name=x -c user.email=someone@example.invalid -c commit.gpgsign=false \
  commit -q --allow-empty --author="$GOOD_NAME <$GOOD_EMAIL>" -m "foreign committer"
expect 1 "foreign committer in an unpublished commit" "$S" unpublished
git reset -q --hard HEAD~1

good commit -q --allow-empty -m "co-authored" -m "Co-authored-by: $BAD"
expect 1 "foreign Co-authored-by trailer" "$S" unpublished
expect 1 "same commit checked as a range (CI)" "$S" range HEAD~1..HEAD
git reset -q --hard HEAD~1

printf 'msg\n\nCo-authored-by: %s\n' "$BAD" >"$T/msg"
expect 1 "commit-msg with a foreign co-author" "$S" message "$T/msg"
# The trailer AI coding tools add (any casing) is refused like any other unlisted identity.
printf 'msg\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n' >"$T/msg"
expect 1 "commit-msg with an AI tool co-author" "$S" message "$T/msg"
good commit -q --allow-empty -m "tool trailer" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
expect 1 "unpublished commit with an AI tool co-author" "$S" unpublished
git reset -q --hard HEAD~1
printf 'msg\n\nCo-authored-by: %s <%s>\n' "$GOOD_NAME" "$GOOD_EMAIL" >"$T/msg"
expect 0 "commit-msg with the repo co-author" "$S" message "$T/msg"

# A signature names its key's owner. Craft signed objects by hand: no key is needed to test.
# The signature header goes right after the committer line, as git writes it.
signed="$(git cat-file commit HEAD | perl -pe 'if (!$done && /^committer /) {
    $_ .= "gpgsig -----BEGIN PGP SIGNATURE-----\n iQEzexample\n -----END PGP SIGNATURE-----\n";
    $done = 1 }' | git hash-object -t commit -w --stdin)"
if ! git cat-file commit "$signed" | grep -q '^gpgsig '; then
  echo "FAIL  could not build the signed-commit fixture"
  fails=$((fails + 1))
fi
git update-ref refs/heads/signed "$signed"
expect 1 "commit signed with a personal key" "$S" unpublished
git update-ref -d refs/heads/signed
tagobj="$(printf 'object %s\ntype commit\ntag vSIGNED\ntagger %s <%s> 1700000000 +0000\n\nx\n%s\n' \
  "$(git rev-parse HEAD)" "$GOOD_NAME" "$GOOD_EMAIL" \
  "$(printf -- '-----BEGIN PGP SIGNATURE-----\nabc\n-----END PGP SIGNATURE-----')" |
  git hash-object -t tag -w --stdin)"
git update-ref refs/tags/vSIGNED "$tagobj"
expect 1 "tag signed with a personal key" "$S" unpublished
git update-ref -d refs/tags/vSIGNED

git -c user.name=x -c user.email=someone@example.invalid -c tag.gpgsign=false tag -a vBAD -m x
expect 1 "annotated tag by a foreign tagger" "$S" unpublished
git tag -d vBAD >/dev/null
good tag -a vGOOD -m x
expect 0 "annotated tag by the repo identity" "$S" unpublished

echo "$fails failure(s)"
exit "$fails"
