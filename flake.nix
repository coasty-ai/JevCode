{
  description = "jevcode: terminal coding agent that edits your code and verifies it with your tests";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system nixpkgs.legacyPackages.${system});
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
      description = "Terminal coding agent that edits your code and verifies it with your tests";
    in
    {
      packages = forAllSystems (
        system: pkgs: {
          default = pkgs.buildNpmPackage {
            pname = "jevcode";
            inherit version;
            # Flake source: git-tracked files only.
            src = ./.;
            # Bare `nodejs` is 24 on nixos-26.05; the release gates run on 22.
            nodejs = pkgs.nodejs_22;
            # Dependencies come from package-lock.json, so there is no npmDepsHash to bump.
            npmDeps = pkgs.importNpmLock { npmRoot = ./.; };
            npmConfigHook = pkgs.importNpmLock.npmConfigHook;
            # No dependency install script is needed: esbuild finds its binary through the
            # @esbuild/<platform> optional package, and fsevents (darwin) would need node-gyp.
            npmRebuildFlags = [ "--ignore-scripts" ];
            # `npm run build` bundles, writes THIRD_PARTY_LICENSES.txt and runs the offline smoke.
            npmBuildScript = "build";
            # The install phase lists files with `npm pack --dry-run`; stop it re-running prepack.
            npmPackFlags = [ "--ignore-scripts" ];
            nativeBuildInputs = [
              pkgs.installShellFiles
              pkgs.git
            ];
            env.JEVCODE_ASSERT_NO_NETWORK = "1";
            # nodejsInstallManuals skips an array-valued package.json "man", so install it here.
            postInstall = ''
              installManPage man/jevcode.1
              installShellCompletion --cmd jevcode \
                --bash completions/jevcode.bash \
                --zsh completions/jevcode.zsh \
                --fish completions/jevcode.fish
            '';
            meta = {
              inherit description;
              homepage = "https://github.com/coasty-ai/JevCode";
              license = pkgs.lib.licenses.mit;
              mainProgram = "jevcode";
              platforms = pkgs.lib.platforms.unix;
            };
          };
        }
      );

      apps = forAllSystems (
        system: pkgs: {
          default = {
            type = "app";
            program = "${self.packages.${system}.default}/bin/jevcode";
            meta = { inherit description; };
          };
        }
      );

      checks = forAllSystems (
        system: pkgs:
        let
          jevcode = self.packages.${system}.default;
        in
        {
          default = jevcode;
          version =
            pkgs.runCommand "jevcode-version-check" { nativeBuildInputs = [ jevcode ]; }
              ''
                export HOME="$TMPDIR" JEVCODE_ASSERT_NO_NETWORK=1
                got="$(jevcode --version)"
                if [ "$got" != "jevcode ${version}" ]; then
                  echo "jevcode --version printed '$got', expected 'jevcode ${version}'" >&2
                  exit 1
                fi
                touch "$out"
              '';
        }
      );

      devShells = forAllSystems (
        system: pkgs: {
          default = pkgs.mkShell { packages = [ pkgs.nodejs_22 ]; };
        }
      );
    };
}
