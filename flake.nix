{
  description = "Imposter on Holochain — per-lobby gameplay DNA, with PeerKit for movement";

  inputs = {
    holonix.url = "github:holochain/holonix?ref=main-0.7";
    nixpkgs.follows = "holonix/nixpkgs";
    flake-parts.follows = "holonix/flake-parts";
  };

  outputs = inputs@{ flake-parts, holonix, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = builtins.attrNames holonix.devShells;
      perSystem = { config, system, pkgs, ... }: {
        devShells.default = pkgs.mkShell {
          inputsFrom = [ holonix.devShells.${system}.default ];
          packages = (with holonix.packages.${system}; [
            holochain
            lair-keystore
            hc-scaffold
            hn-introspect
            rust
            # hc-spin launches a local kitsune2 bootstrap/signal server and
            # expects this binary on PATH.
            bootstrap-srv
          ]) ++ (with pkgs; [
            # 22+ required: the relay (libp2p / it-queue) and Vite dev deps call
            # Promise.withResolvers, which does not exist in Node 20.
            nodejs_22
            binaryen
          ]);
          shellHook = ''
            export CARGO_TARGET_DIR="$PWD/target"
          '';
        };
      };
    };
}
