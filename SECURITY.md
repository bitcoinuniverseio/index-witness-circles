# Security policy

Do not report a suspected fund-loss, parser-divergence, signature, or credential vulnerability in a public issue.

Send a private report to the Bitcoin Universe security contact configured for the eventual repository. Until a public security address is published, keep the report local and coordinate directly with the repository owner.

Include:

- Affected revision and parser version
- Network and Bitcoin Core version
- Raw transaction or minimal fixture with private data removed
- Expected and actual classification or state root
- Reproduction steps
- Potential fund, availability, privacy, or consensus impact

Never include seed phrases, private keys, authentication tokens, production RPC credentials, or user-identifying manifests.

Critical categories include fund theft through misleading validation, two compliant parsers reaching different state, rollback failure, lease fencing bypass, remotely reachable administration, credential exposure, and metadata injection that executes in a consumer.

The indexer is non-custodial. It does not make a wallet safe by itself. Wallets must independently validate the full frozen transaction before signing.
