#!/bin/sh
# Run the sweettests one at a time, each in its own process. In one process,
# memory builds up from test to test until the machine runs out (it did on a
# 14 GB machine). Stops at the first failure. Pass test names to run just those.
set -e
sh "$(dirname "$0")/build-forge-dna.sh"
cd "$(dirname "$0")/../tests"
cargo test --test full_round --no-run
names=${*:-$(cargo test --test full_round -- --list 2>/dev/null | sed -n 's/: test$//p')}
for name in $names; do
  echo "=== $name"
  cargo test --test full_round -- --exact "$name"
done
