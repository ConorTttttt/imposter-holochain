#!/usr/bin/env bash
# Run from the pinned Agent 4 checkout with HWC and both kits beside its scripts.
set -euo pipefail

agent2=integration/compatibility/hwc-imposter-compatibility
agent3=agent3-kit/ci/agent3-h2hc-kit
background=hwc/packages/extension/src/background/index.ts

test "$(git rev-parse HEAD)" = 0f7b17592e682a7b7d77e9346528cba69a096cdc
test "$(git -C agent3-kit rev-parse HEAD)" = f49b0dfcc9f8b86a3e2abcd48e6c13375c347ed5
test "$(git -C hwc rev-parse HEAD)" = 0c391226e78769d44ccb4661881ed8998b15f903
git -C integration merge-base --is-ancestor 339643b513a91283b69d21ceca322ef6fd6a89a9 HEAD
git apply --check --unidiff-zero integration/ci/installed-role/browser-demo.patch
git apply --unidiff-zero integration/ci/installed-role/browser-demo.patch

python3 "$agent2/verify_pinned_sources.py" hwc
git -C hwc switch -c fix/imposter-hwc-compatibility
python3 "$agent2/apply.py" hwc --write
python3 "$agent2/private-role/apply_restricted_hwc_handler.py" hwc --write
python3 "$agent2/private-role/apply_installed_hwc_receiver.py" hwc --write
git -C hwc diff --check

git show 8b167bf7f5bda0b213cd0a1679b35e9d252a4a36:scripts/browser-poc-hwc-smoke.mjs > scripts/browser-poc-hwc-smoke.mjs
node scripts/browser-poc-ci-worker-probe.mjs hwc
python3 "$agent3/instrument_agent4_browser.py" scripts/browser-poc-hwc-smoke.mjs
python3 "$agent3/instrument_native_authority.py" scripts/agent3-h2hc-real-browser-bridge.mjs
bridge=scripts/agent3-native-authority-browser-bridge.mjs
for stage in native_convergence exact_lobby_op negative_validation native_admin; do
  python3 "$agent3/instrument_${stage}.py" "$bridge"
done
python3 scripts/agent4-native-three-player-instrument.py "$bridge"
python3 integration/ci/installed-role/instrument.py "$background" "$bridge"
node --check "$bridge"
