{
  pkgs,
  application,
  system ? pkgs.stdenv.hostPlatform.system,
}: let
  name = "${application.pname}-${application.version}-${system}";
  executable = application.meta.mainProgram;
in
  pkgs.runCommand "${name}-archive" {
    nativeBuildInputs = [
      pkgs.gnutar
      pkgs.gzip
    ];
  } ''
    mkdir -p "$out"

    tar \
      --sort=name \
      --mtime=@0 \
      --owner=0 \
      --group=0 \
      --numeric-owner \
      -C "${application}/bin" \
      -cf - "${executable}" |
      gzip -n > "$out/${name}.tar.gz"
  ''
