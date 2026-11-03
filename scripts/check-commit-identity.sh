#!/usr/bin/env bash
# Refuse any commit, tag or co-author identity not listed in .github/commit-identities.
#
# This repository is public: an author, committer, tagger or Co-authored-by email in its history
# is published, and a squash merge copies every commit author of a pull request into main as a
# co-author. So the check is an allowlist, run before anything is committed or pushed, and in CI.
#
# Usage:
#   check-commit-identity.sh configured        the identity git would use for a new commit
#   check-commit-identity.sh message <file>    Co-authored-by trailers in a commit message
#   check-commit-identity.sh range <revs...>   every commit in a rev-list range (and its trailers)
#   check-commit-identity.sh unpublished       every local commit not on a remote, and every tag
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
allowlist="$root/.github/commit-identities"
problems=0

if [ ! -f "$allowlist" ]; then
  echo "commit identity check: $allowlist is missing" >&2
  exit 1
fi

# allowed <role> <email>: is this email listed for this role?
allowed() {
  grep -v '^#' "$allowlist" | grep -Fxq "$1 $2"
}

refuse() {
  echo "commit identity check: $1" >&2
  problems=$((problems + 1))
}

ident_email() {
  git var "$1" | sed -E 's/^.*<([^>]*)>.*$/\1/'
}

check_trailers() {
  local where="$1" email
  while IFS= read -r email; do
    [ -n "$email" ] || continue
    allowed author "$email" || refuse "$where: Co-authored-by $email is not an allowed identity"
  done < <(grep -iE '^co-authored-by:' | sed -E 's/^.*<([^>]*)>.*$/\1/')
}

# has_signature <commit|tag> <object>: does the raw object carry a GPG, SSH or X.509 signature?
has_signature() {
  git cat-file "$1" "$2" | grep -qE '^gpgsig(-sha256)? |^-----BEGIN (PGP|SSH|SIGNED) '
}

check_commit() {
  local sha="$1" author committer
  author="$(git log -1 --format=%ae "$sha")"
  committer="$(git log -1 --format=%ce "$sha")"
  allowed author "$author" || refuse "commit ${sha:0:7}: author $author is not an allowed identity"
  allowed committer "$committer" ||
    refuse "commit ${sha:0:7}: committer $committer is not an allowed identity"
  # A signature carries its key's id, and a key names its owner: only GitHub's own commits (squash
  # merges, web edits) may be signed, by GitHub's key.
  if [ "$committer" != "noreply@github.com" ] && has_signature commit "$sha"; then
    refuse "commit ${sha:0:7} is signed; this repository's commits are unsigned (commit.gpgsign)"
  fi
  # Redirected, not piped: a function on the right of a pipe runs in a subshell, and the
  # problems it counts there would be lost.
  check_trailers "commit ${sha:0:7}" < <(git log -1 --format=%B "$sha")
}

check_range() {
  local sha
  while IFS= read -r sha; do
    check_commit "$sha"
  done < <(git rev-list "$@")
}

check_tags() {
  local tag tagger
  while IFS=' ' read -r tag tagger; do
    # Lightweight tags have no tagger; their commit is checked with the rest.
    [ -n "$tagger" ] || continue
    allowed tagger "$tagger" || refuse "tag $tag: tagger $tagger is not an allowed identity"
    if has_signature tag "$tag"; then
      refuse "tag $tag is signed; this repository's tags are unsigned (tag.gpgsign)"
    fi
  done < <(git for-each-ref refs/tags --format='%(refname:short) %(taggeremail:trim)')
}

case "${1:-}" in
configured)
  email="$(ident_email GIT_AUTHOR_IDENT)"
  allowed author "$email" || refuse "git is set to author commits as $email"
  email="$(ident_email GIT_COMMITTER_IDENT)"
  allowed committer "$email" || refuse "git is set to commit as $email"
  ;;
message)
  check_trailers "commit message" <"${2:?message file required}"
  ;;
range)
  shift
  check_range "$@"
  ;;
unpublished)
  check_range --all --not --remotes
  check_tags
  ;;
*)
  echo "usage: $0 configured | message <file> | range <revs...> | unpublished" >&2
  exit 2
  ;;
esac

if [ "$problems" -gt 0 ]; then
  echo "Set this repository's identity with:" >&2
  echo "  git config user.name 0x43687269735079" >&2
  echo "  git config user.email 289092784+0x43687269735079@users.noreply.github.com" >&2
  echo "  git config commit.gpgsign false && git config tag.gpgsign false" >&2
  echo "then rewrite the refused commits or tags before pushing." >&2
  echo "Allowed identities: .github/commit-identities" >&2
  exit 1
fi
