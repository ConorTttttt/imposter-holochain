#!/usr/bin/env python3
"""Inject CI-only signed-source-chain native negative, preserving HWC positive gates."""
from pathlib import Path
import sys

p=Path(sys.argv[1])
s=p.read_text()
anchor="  // Do not exit at the first HTTP publish batch."
assert s.count(anchor)==1, "native signed fixture insertion anchor drift"
insert=r"""
  // Separate synthetic signing identity: bypass only the *local authoring*
  // validation for the negative test, never native integrity or server auth.
  const {pathToFileURL:negativeFixtureUrl}=await import('node:url');
  try {
    const fixture=await import(negativeFixtureUrl(path.join(ROOT,
      'agent3-kit/ci/agent3-h2hc-kit/native-negative-fixture.mjs')).href);
    await fixture.runNativeNegativeFixture({
      HWC,ROOT,OUT_LOG,m,host,evidence,record,publicHoloHash
    });
  } catch(error) {
    evidence.native_signed_negative_error=String(error?.message||error).slice(0,350);
    record('NATIVE_INTEGRITY_INVALID_LOBBY_REJECTION','BLOCKED',
      'Signed test fixture did not prove native app-integrity rejection; failure class: '+
      evidence.native_signed_negative_error);
  }

"""
s=s.replace(anchor,insert+anchor,1)
p.write_text(s)
print("Injected isolated CI-signed native operation probe",p)
