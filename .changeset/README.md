# Changesets

Every user-visible change adds a file here (`bun changeset`). On `main`, the
Release workflow turns pending changesets into a "Version Packages" PR; merging
that PR publishes to npm with trusted publishing. See `.github/workflows/release.yml`.
