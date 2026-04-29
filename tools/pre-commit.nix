_: {
  # Nix
  alejandra.enable = true;
  deadnix.enable = true;
  statix.enable = true;

  # Generic file checks
  check-yaml.enable = true;
  check-toml.enable = true;
  check-json.enable = true;
  check-merge-conflicts.enable = true;
  end-of-file-fixer.enable = true;
  trim-trailing-whitespace.enable = true;
  check-added-large-files = {
    enable = true;
    args = ["--maxkb=1000"];
  };
}
