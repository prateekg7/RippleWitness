# RippleWitness CI receipt check (F-13)

Block merges whose HEAD lacks a valid review receipt.

## Setup (subject repo)

1. Provision the key once, from the machine that issues receipts:

   ```sh
   xxd -p .ripplewitness/key | tr -d '\n'   # 64 hex chars, no newline
   ```

   Store it as a repo secret named `RIPPLEWITNESS_KEY_HEX`. Anyone with this
   secret can mint receipts, so limit who can read it.

   For ed25519 receipts (issued with `{"algorithm": "ed25519"}`), provision
   the *public* key instead — it verifies only and is safe to expose:

   ```sh
   cat .ripplewitness/signing.pub   # store as repo variable RIPPLEWITNESS_PUBKEY_PEM
   ```

   ```yaml
   - uses: ./ci-action
     with:
       receipt-pubkey-pem: ${{ vars.RIPPLEWITNESS_PUBKEY_PEM }}
   ```

   The verifier dispatches on the receipt shape: HMAC notes need the key
   secret, ed25519 notes need the public variable.

2. Fetch notes in CI (`actions/checkout` drops them by default):

   ```yaml
   - uses: actions/checkout@v4
     with:
       fetch-depth: 0
   - run: git fetch origin refs/notes/ripplewitness:refs/notes/ripplewitness || true
   ```

3. Run the check (composite action, zero dependencies):

   ```yaml
   - uses: ./ci-action   # or your fork / published tag
     with:
       receipt-key-hex: ${{ secrets.RIPPLEWITNESS_KEY_HEX }}
   ```

## What it proves

- HEAD carries a receipt note whose signature validates — HMAC under the shared key, or ed25519 under the published public key.
- The receipt binds this exact HEAD and this exact `baseRef..HEAD` diff —
  any post-review change fails with `diffHash_mismatch`.
- The assurance tier prints on success (`VALID tier:L3`); treat `L0` and
  `unknown (pre-K-06 receipt)` as weak evidence in branch protection.

## What it does not prove

- `scenarioHash` is not re-checked: scenarios live in the reviewer's
  checkout, not the subject repo. The receipt still binds them for audit.
- Artifact hashes (model weights, datasets) are recorded, not re-hashed.
