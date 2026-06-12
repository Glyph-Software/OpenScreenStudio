#!/usr/bin/env bash
#
# Create a *stable self-signed* code-signing identity in the login keychain.
#
# Why this exists: we have no paid Apple Developer account, so `tauri build`
# would otherwise ad-hoc sign the app. Ad-hoc signatures have no stable
# Designated Requirement, which makes macOS TCC (Screen Recording /
# Accessibility) grants fail to stick across launches on *other* machines —
# the user grants permission but the app never recognizes it. A self-signed
# cert gives every build a stable identity that TCC can pin the grant to.
#
# This does NOT make the app notarized — users on other Macs still see a
# Gatekeeper warning on first launch (right-click → Open). It only fixes
# permission persistence. See README "Installing on another Mac".
#
# Idempotent: re-running is a no-op once the identity exists. Run once per
# machine that produces release builds. Signing may prompt once for keychain
# access — click "Always Allow".
set -euo pipefail

# Keep this in sync with package.json's "build:signed" APPLE_SIGNING_IDENTITY.
IDENTITY="OpenScreen Studio Self-Signed"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning "$KEYCHAIN" 2>/dev/null | grep -qF "$IDENTITY"; then
  echo "✓ Code-signing identity already present: \"$IDENTITY\""
  exit 0
fi

echo "Creating self-signed code-signing identity \"$IDENTITY\"…"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Self-signed cert with the Code Signing extended key usage. macOS only treats
# a cert as a valid codesigning identity if it carries this EKU.
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
  -subj "/CN=$IDENTITY" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

# OpenSSL 3 defaults to a PKCS#12 MAC/cipher that macOS's `security import`
# can't verify (it fails with "MAC verification failed"). `-legacy` plus an
# explicit non-empty password keeps the bundle in the SHA1/3DES form Apple
# can read.
P12_PASS="oss"
openssl pkcs12 -export -legacy -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
  -out "$tmp/identity.p12" -passout "pass:$P12_PASS" >/dev/null 2>&1

# Import key+cert, allowing codesign to use the private key.
security import "$tmp/identity.p12" -k "$KEYCHAIN" -P "$P12_PASS" -T /usr/bin/codesign -A >/dev/null

# Trust the cert for code signing so it shows up as a *valid* (-v) identity.
# Adds to the user trust domain (no sudo); may prompt for confirmation.
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$tmp/cert.pem" >/dev/null 2>&1 || \
  echo "  (note: could not auto-trust the cert; if signing fails, trust it manually in Keychain Access)"

# Let codesign use the key non-interactively (prompts once for keychain pw).
security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
  -k "" "$KEYCHAIN" >/dev/null 2>&1 || \
  echo "  (note: codesign may prompt for keychain access on first build — click \"Always Allow\")"

echo "✓ Created code-signing identity: \"$IDENTITY\""
