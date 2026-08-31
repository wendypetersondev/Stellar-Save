# Runbook: Stellar-Save Contract Upgrade & Migration Procedure

This runbook outlines the operational steps, verification procedures, safety protocols, and rollback strategies for executing smart contract upgrades on the `stellar-save` contract deployed to the Stellar network (Soroban).

**Related issues:** #86 (integration tests), #72 (version guard), #4 (this runbook).

---

## 1. Overview & Architecture

The `stellar-save` smart contract uses Soroban WASM contract code updates alongside two independent version counters:

- **Contract binary version** (`CONTRACT_VERSION_KEY`) — incremented on every WASM upgrade. Enforced by the upgrade guard in `migration.rs:require_upgrade_version_guard`, which rejects any `upgrade_contract` call where `new_version <= current_version`. This prevents accidental downgrade or double-upgrade (issue #72).
- **Storage schema version** (`SCHEMA_VERSION_KEY` / `StorageVersion`) — tracks which data layout is actually on-chain. Advanced by calling `migrate_storage` after the WASM swap.

Key upgrade principles:
- **State Preservation**: All storage entries (Group data, Member profiles, Contribution records, Config) survive across upgrades — verified by the integration test suite (see §6).
- **Schema Idempotency**: Migration functions check the current version and are safe no-ops if already at the target version.
- **Rollback Safety**: The v1→v2 migration is fully reversible. The `v1_to_v2::rollback` function removes only the entries it backfilled, leaving pre-existing data untouched.

---

## 2. Pre-Upgrade Checklist

Before deploying any WASM bytecode update or triggering schema migration:

- [ ] **Integration test suite passes**: Run all upgrade integration tests locally (see §6). All tests in `upgrade_integration_tests` must pass, including the end-to-end `test_upgrade_then_migrate_storage_end_to_end` test.
- [ ] **WASM Verification**: Build release WASM using reproducible build flags and verify SHA-256 digest against `stellar_save.wasm.sha256`.
- [ ] **State Snapshot**: Record the state hash or export key storage entries from Testnet/Mainnet state before execution.
- [ ] **Admin Authentication**: Confirm the deploying keys have valid Admin privileges on the target contract instance.
- [ ] **Schema Compatibility**: Ensure new enum discriminants or data field additions are backward compatible with pre-upgrade client calls.
- [ ] **Version number**: Decide the new `new_version` integer — it must be strictly greater than the value returned by `get_contract_version`.

---

## 3. Execution Procedure

### Step 3.1: Upload New WASM and Obtain Hash
```bash
# Build the release WASM
cargo build \
  --manifest-path contracts/stellar-save/Cargo.toml \
  --target wasm32-unknown-unknown \
  --release

# Upload to the network and capture the returned hash
stellar contract upload \
  --network testnet \
  --source admin_key \
  --wasm target/wasm32-unknown-unknown/release/stellar_save.wasm
# → outputs: <NEW_WASM_HASH>
```

### Step 3.2: Upgrade Contract Binary (version guard enforced)
```bash
stellar contract invoke \
  --network testnet \
  --source admin_key \
  --id <CONTRACT_ID> \
  -- upgrade_contract \
  --caller <ADMIN_ADDRESS> \
  --new_wasm <NEW_WASM_HASH> \
  --new_version <NEW_VERSION>
```

`new_version` must be strictly greater than the current on-chain value of `get_contract_version`. The contract will return `InvalidState` (error 1003) and reject the call otherwise.

Verify the binary version advanced:
```bash
stellar contract invoke --network testnet --id <CONTRACT_ID> -- get_contract_version
```

### Step 3.3: Execute Storage Schema Migration (if required)
If the upgrade includes a storage schema change (e.g. v1 → v2):
```bash
stellar contract invoke \
  --network testnet \
  --source admin_key \
  --id <CONTRACT_ID> \
  -- migrate_storage \
  --caller <ADMIN_ADDRESS>
```

Verify schema version advanced:
```bash
stellar contract invoke --network testnet --id <CONTRACT_ID> -- get_storage_version
```

---

## 4. Post-Upgrade Verification Checklist

- [ ] **Contract version**: `get_contract_version` returns the new version number.
- [ ] **Storage version**: `get_storage_version` returns the expected schema version (≥ 2 after v1→v2 migration).
- [ ] **Group data**: `get_group(<existing_id>)` returns the pre-upgrade group with all fields intact.
- [ ] **Membership**: `is_member(<group_id>, <member_address>)` returns `true` for a known member.
- [ ] **Contribution records**: Contribution history queryable for existing groups.
- [ ] **No downgrade possible**: Attempting `upgrade_contract` with any version ≤ current is rejected.

---

## 5. Rollback Procedure

### 5.1 If `migrate_storage` has NOT yet been called (schema unchanged)

A WASM-only rollback is straightforward — the old code is reinstated and the schema was never touched:

```bash
# Re-upload the previous WASM if not already present
stellar contract upload --network testnet --source admin_key --wasm <OLD_WASM_PATH>

# Upgrade back to the previous WASM hash
# NOTE: new_version must still be > current on-chain version because the upgrade
# guard is monotonic.  Increment again and document the rollback in the changelog.
stellar contract invoke \
  --network testnet \
  --source admin_key \
  --id <CONTRACT_ID> \
  -- upgrade_contract \
  --caller <ADMIN_ADDRESS> \
  --new_wasm <OLD_WASM_HASH> \
  --new_version <ROLLBACK_VERSION>
```

### 5.2 If `migrate_storage` HAS been called (schema advanced)

Rollback requires reversing the storage migration AND then reinstating the old WASM:

```bash
# 1. Invoke the schema rollback (removes only backfilled entries, preserves originals)
#    This must be called while the NEW binary is still in place, as only the new
#    binary contains the rollback logic.
stellar contract invoke \
  --network testnet \
  --source admin_key \
  --id <CONTRACT_ID> \
  -- migrate_storage_rollback \
  --caller <ADMIN_ADDRESS>

# 2. Verify schema returned to V1
stellar contract invoke --network testnet --id <CONTRACT_ID> -- get_storage_version
# → should return 1

# 3. Reinstate old WASM binary (see §5.1 for the upgrade_contract command)
```

### 5.3 Post-Rollback Verification

Re-run the pre-upgrade smoke tests and confirm:
- `get_storage_version` returns the previous version.
- Existing groups, members, and contributions are still readable.
- `get_group_balance` returns correct values.

---

## 6. Automated Test Suite

The upgrade integration tests live in `contracts/stellar-save/src/upgrade_integration_tests.rs`. They implement the full acceptance criteria from issue #86:

| Test | What it verifies |
|------|-----------------|
| `test_upgrade_path_state_preserved` | All storage survives v1→v2 migration |
| `test_upgrade_then_migrate_storage_end_to_end` | **End-to-end**: upgrade_contract → migrate_storage → data queryable via client |
| `test_upgrade_contract_state_readable_via_client_after_migrate` | Groups readable via client after upgrade + migrate |
| `test_downgrade_via_upgrade_contract_rejected` | `upgrade_contract` rejects same/lower versions (issue #72) |
| `test_downgrade_rejected_by_version_guard` | Version guard function rejects same-version |
| `test_older_version_rejected` | Version guard rejects any lower version |
| `test_double_upgrade_rejected` | Second call with same version rejected |
| `test_full_roundtrip_v1_v2_v1` | seed → migrate → rollback → data intact |
| `test_rollback_restores_v1_state` | Rollback removes backfilled entries |
| `test_rollback_preserves_pre_existing_token_config` | Rollback only removes what it wrote |
| `test_upgrade_contract_unauthorized_caller_rejected` | Non-admin rejected from upgrade_contract |
| `test_migrate_storage_unauthorized_rejected` | Non-admin rejected from migrate_storage |
| `test_migration_record_written_on_apply` | Audit trail written after migration |
| `test_migration_record_written_on_rollback` | Audit trail updated after rollback |

Run locally:
```bash
# All upgrade integration tests
cargo test \
  --manifest-path contracts/stellar-save/Cargo.toml \
  upgrade_integration_tests \
  -- --test-threads=1

# With output
cargo test \
  --manifest-path contracts/stellar-save/Cargo.toml \
  upgrade_integration_tests \
  -- --test-threads=1 --nocapture
```

CI runs these tests automatically on every push and pull request via `.github/workflows/upgrade-tests.yml`.
