# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through GitHub:
**Security → Report a vulnerability** on this repository (private vulnerability reporting).
If you cannot use GitHub, write to sitekeep@7dimensions.eu. We read reports in English and Turkish.

Include what is affected (version, edition, configuration), how to reproduce it and the impact you
expect. Every installation also answers `/.well-known/security.txt` (RFC 9116) with these contacts.

## Coordinated disclosure

| Step | When |
|---|---|
| We confirm receipt | within 3 working days |
| We confirm or reject the vulnerability and tell you our assessment (CVSS) | within 10 working days |
| Fix released for the supported versions | as soon as possible; target 30 days for critical and high, 90 days for others |
| Public advisory | when the fix is released, or 90 days after the report at the latest, unless we agree another date with you |

We keep you informed until the fix is released, credit you in the advisory unless you prefer not, and
ask you not to disclose the problem publicly before the advisory. We will not take legal action
against good-faith research that respects this policy, avoids privacy violations and service
disruption, and uses only test data and installations you own.

## Supported versions

| Version | Security fixes |
|---|---|
| Latest minor release of the current major (e.g. 1.4.x) | Yes |
| Earlier minor releases of the current major | No: upgrade to the latest minor (upgrades within a major are backward compatible and migrate the database automatically) |
| Previous major (from the release of the next one) | Critical and high fixes for at least 12 months |
| **1.x** | Security fixes until **at least three years after the release of 1.0** |

The support period of each major version is announced in its release notes; it is never shortened
after release. On-premises installations upgrade with `sitekeep upgrade` (installation bundle) or
`docker compose pull` (Docker Compose), as the release notes describe.

## Advisories and CVEs

Fixed vulnerabilities are published as **GitHub Security Advisories** (GHSA) on this repository, with
a **CVE** identifier requested through GitHub (a CVE Numbering Authority). An advisory names the
affected and fixed versions, the severity (CVSS), workarounds and credits, and the release notes of
the fixed version link to it. Watch the repository (Custom → Security alerts) or its releases to be
notified; Dependabot also picks up advisories for SiteKeep's npm packages.

## EU Cyber Resilience Act

SiteKeep is maintained with the vulnerability handling requirements of the Cyber Resilience Act
(Regulation (EU) 2024/2847, Annex I Part II) in mind:

- **Reporting to ENISA:** an **actively exploited vulnerability** in SiteKeep, or a **severe incident**
  affecting its security, is notified through ENISA's single reporting platform to the CSIRT
  designated as coordinator (Art. 14): an early warning **within 24 hours** of becoming aware of it, a
  notification within 72 hours, and a final report within 14 days after a fix is available (one month
  for a severe incident). Users are informed of the vulnerability and of mitigations without undue
  delay.
- **Software bill of materials:** every release carries a CycloneDX SBOM of SiteKeep's production
  dependencies (`sitekeep-<version>-sbom.cdx.json`, attached to the GitHub release). It can be rebuilt
  from the tagged source with `npm ci && npm sbom --sbom-format cyclonedx --omit dev`.
- **Supply chain:** dependencies come from the lockfile only (`npm ci`); CI fails on high or critical
  advisories in production dependencies (`npm audit`), runs CodeQL, and Dependabot proposes updates.
  Third-party licences: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Secure by default:** every outbound connection is off until an administrator turns it on, no
  telemetry, strict content security policy, security headers, failed-attempt limits and optional
  two-factor authentication ([privacy](docs/features/PRIVACY.md), [sign-in
  security](docs/features/SIGN_IN_SECURITY.md)).
- **Security updates** are released separately from feature updates where possible, so they can be
  applied without other changes.

## Scope

SiteKeep Community (this repository) and its official container images and installation bundles.
Enterprise modules and the hosted cloud service are covered by the same reporting channel.

Out of scope: vulnerabilities that need administrator rights on the installation, physical access to
the server, or a configuration the documentation advises against (for example HTTP without TLS on an
open network); findings of automated scanners without a demonstrated impact; problems of an
organisation's own installation (contact that organisation).
