# Security policy

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting for this repository (Security tab, "Report a vulnerability"). If that is unavailable, contact the maintainer through the e-mail address on their GitHub profile.

Include the affected version or commit, steps to reproduce, and the impact you expect. You will get an acknowledgement within a few days; this is a small project, so fix times vary.

## Scope

In scope: the server, worker, client SDK, dashboard and the reference deployment files in this repository. Out of scope: vulnerabilities in third-party dependencies that are already public (report those upstream), and the development defaults in `docker-compose.yml`, which are documented as development-only.

## Supported versions

Only the latest commit on `main`. There have been no stable releases yet.

## What to expect from the project

See [docs/security.md](docs/security.md) for the implemented controls and the known limits. Syncra has not had an independent security audit.
