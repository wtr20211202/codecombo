# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately via
[GitHub Security Advisories](../../security/advisories/new)
("Report a vulnerability"). Please do **not** open a public issue for
anything you believe has security impact.

When reporting, include if possible:

- A description of the issue and its impact
- Steps to reproduce (or a minimal proof of concept)
- The version / commit you tested against
- Your deployment shape (local only, LAN-exposed, behind a reverse proxy)

## Scope notes

- Codecombo is a self-hosted single-binary web app. By default it listens on
  `0.0.0.0:9999` and protects all `/api/*` routes and business WebSocket
  channels with the global lock (password prompt on first start). Reports
  about exposures caused by deliberately disabling the lock or binding to an
  untrusted network are still welcome, but please check
  [the security notes in the README](README.md#configuration--security) first.
- dsh integration: Codecombo does not include or distribute dsh; it only
  provides an optional loopback embedding channel to a locally installed dsh
  instance. Vulnerabilities in dsh itself belong to that project.

## What to expect

This is a solo-maintained project; there is no dedicated security team and no
guaranteed response time. The maintainer takes valid reports seriously and
aims to acknowledge them and ship fixes in a reasonable timeframe, prioritized
by impact. There is currently no bug bounty or paid reward program.
