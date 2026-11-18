#!/usr/bin/env python3
"""Fix failures proved by H2HC run 44159523882, in a separate security commit."""
import argparse
from pathlib import Path
import subprocess


def one(file, old, new, count=1):
    data = file.read_text()
    n = data.count(old)
    if n != count:
        raise RuntimeError(f"{file}: expected {count} instances of {old[:45]!r}, got {n}")
    file.write_text(data.replace(old, new, count))


def patch(repo):
    branch = subprocess.check_output(
        ["git", "-C", str(repo), "branch", "--show-current"], text=True
    ).strip()
    if branch != "security/imposter-browser-networking":
        raise RuntimeError(f"refusing to modify branch {branch!r}")

    f = repo / "src/router.rs"
    one(f, "state.agent_proxy.register(dna.clone(), agent.clone(), tx).await;",
        "state.agent_proxy.register(dna.clone(), agent.clone(), tx.clone()).await;")

    f = repo / "src/routes/websocket.rs"
    one(f, "let dna = DnaHash::from_raw_36(vec![5u8;36]);",
        "let dna = DnaHash::from_raw_32(vec![5u8;32]);")
    one(f, "assert!(matches!(result, Some(ServerMessage::Registered { .. })));",
        'assert!(matches!(result, Some(ServerMessage::Registered { .. })), "register response: {result:?}");')
    one(f, """let mut state = ConnectionState::default();
        state.authenticated = true;
        state.authenticated_agent = Some(agent_a.clone());""",
        """let mut state = ConnectionState {
            authenticated: true,
            authenticated_agent: Some(agent_a.clone()),
            ..Default::default()
        };""", 2)

    f = repo / "src/auth/middleware.rs"
    one(f, '.uri(&format!("/dht/{}/record/some-hash", dna))',
        '.uri(format!("/dht/{}/record/some-hash", dna))', 3)

    f = repo / "src/config.rs"
    one(f, """let mut config = Configuration::default();
        config.admin_secret = Some("test-secret".to_string());""",
        """let config = Configuration {
            admin_secret: Some("test-secret".to_string()),
            ..Default::default()
        };""")

    # Legacy handler remains for native compatibility, not called in P0.
    f = repo / "src/lib.rs"
    one(f, "mod kitsune;",
        "#[allow(dead_code)] // Legacy Kitsune compatibility implementation, inactive in P0.\nmod kitsune;")

    # The space ID remains available for future authenticated native signals.
    f = repo / "src/gateway_kitsune.rs"
    one(f, "struct ProxySpaceHandler {\n    space_id: SpaceId,",
        "struct ProxySpaceHandler {\n    #[allow(dead_code)] // Retained for future authenticated native signal routing.\n    space_id: SpaceId,")
    subprocess.run(["git", "-C", str(repo), "diff", "--check"], check=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--repo", type=Path, default=Path("."))
    patch(p.parse_args().repo.resolve())
