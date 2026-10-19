# Third-party software and identity

OpenClaw HUB is an independent client of OpenClaw. Its name refers to the platform
it connects to; this project is not endorsed by or affiliated with that platform.

The project MIT license covers this project's source, not its dependencies or
Node/container runtime. Those retain their upstream licenses. The npm lockfile
records the resolved packages and licenses; preserve their notices when
redistributing binaries or container images. In particular:

| Direct dependency | License |
| --- | --- |
| Express | MIT |
| Multer | MIT |
| ws | MIT |
| web-push | MPL-2.0 |
| Electron (optional Linux desktop runtime) | MIT, with bundled Chromium/third-party notices |

Source links: [Express](https://github.com/expressjs/express),
[Multer](https://github.com/expressjs/multer), [ws](https://github.com/websockets/ws),
[web-push](https://github.com/web-push-libs/web-push).
The installed npm packages contain their license files. `npm ci` retrieves them;
`node_modules` and Docker images are not bundled in this source distribution.

The supplied Hub H-mark icons are generated from the project's geometric SVG
artwork. No OpenClaw logo, external fonts, customer branding or stock photos are
included in this web edition.
