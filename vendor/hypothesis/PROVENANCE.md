# Hypothesis anchoring components

Source: https://github.com/hypothesis/client
Commit: 1c9d82c8beed244d42cb2f685ae17fdf4824ad70
Source directory: src/annotator/anchoring/

The six TypeScript files in anchoring/ are unmodified copies from the pinned upstream commit. Their BSD-2-Clause license and third-party notices are included in LICENSE. Only the anchoring components are bundled into the viewer. This project does not run the Hypothesis sidebar, h service, authentication system, or hosted API. The local collaboration server and interface are independent implementations.

Type-only imports from the upstream API type definitions are erased by esbuild. Runtime dependency approx-string-match is installed from its pinned package version.
