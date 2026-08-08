#!/usr/bin/env bash
# Archive, export and ship a build to TestFlight.
#
# One script for both the laptop and CI, deliberately: a release path that only
# exists inside a YAML file cannot be run when it breaks, and one that only
# exists on a laptop is the reason a project has exactly one person who can ship.
#
# Needs, in the environment:
#   ASC_KEY_ID     App Store Connect API key id
#   ASC_ISSUER_ID  the issuer UUID that key belongs to
# and the private key at ~/.appstoreconnect/private_keys/AuthKey_<ID>.p8, which
# is where `xcrun altool` documents that it looks.
set -euo pipefail

# DEVELOPER_DIR rather than `sudo xcode-select -s`, so this needs no password.
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
cd "$(dirname "$0")/.."

SCHEME="VueLights"
BUILD_DIR="${BUILD_DIR:-build}"
ARCHIVE="$BUILD_DIR/$SCHEME.xcarchive"
EXPORT_DIR="$BUILD_DIR/export"

# Local credentials, if there are any. Anything already in the environment wins —
# CI sets these from repo secrets and has no .env, and a stale local file must
# not override a deliberate override.
if [ -f .env ]; then
  before_key="${ASC_KEY_ID:-}"; before_issuer="${ASC_ISSUER_ID:-}"
  set -a; . ./.env; set +a
  [ -n "$before_key" ] && ASC_KEY_ID="$before_key"
  [ -n "$before_issuer" ] && ASC_ISSUER_ID="$before_issuer"
fi

: "${ASC_KEY_ID:?set ASC_KEY_ID — the App Store Connect API key id}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID — the issuer UUID from App Store Connect → Users and Access → Integrations. It is NOT recoverable from the .p8.}"

KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
[ -f "$KEY_PATH" ] || { echo "no API key at $KEY_PATH" >&2; exit 1; }

# The build number, derived rather than stored.
#
# App Store Connect rejects a CFBundleVersion it has already accepted under the
# same marketing version, and a number committed to project.yml is one somebody
# has to remember to bump — which they will not, and the rejection arrives
# minutes into an upload. Commit count is monotonic on main and identical for
# anyone who checks out the same commit.
BUILD_NUMBER="${BUILD_NUMBER:-$(git rev-list --count HEAD)}"
echo "▸ Build $BUILD_NUMBER"

echo "▸ Generating the project"
xcodegen generate

rm -rf "$ARCHIVE" "$EXPORT_DIR"

echo "▸ Archiving"
# -allowProvisioningUpdates with the API key lets Xcode fetch or create the App
# Store profile and the team's distribution certificate without anybody opening
# a UI. That is why there is no .p12 anywhere in this repo.
xcodebuild archive \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  -quiet

echo "▸ Exporting"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist Scripts/ExportOptions.plist \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  -quiet

IPA="$(find "$EXPORT_DIR" -name '*.ipa' | head -1)"
[ -n "$IPA" ] || { echo "export produced no .ipa" >&2; exit 1; }
echo "▸ Built $IPA"

# Validate before uploading. The same checks run server-side afterwards, but
# there they cost a full transfer and arrive by email some minutes later.
echo "▸ Validating"
xcrun altool --validate-app -f "$IPA" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

echo "▸ Uploading to TestFlight"
xcrun altool --upload-app -f "$IPA" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

echo "✓ Build $BUILD_NUMBER uploaded."
echo "  It appears in TestFlight once Apple finishes processing — usually 5–15"
echo "  minutes — and internal testers get it with no review step."
