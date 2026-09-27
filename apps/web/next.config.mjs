/** @type {import('next').NextConfig} */
const nextConfig = {
  // v0 ships `typescript.ignoreBuildErrors: true`. That is off here: a build that
  // passes while the types are wrong is not a passing build, and this repo's other
  // gates are all measured rather than assumed.
  images: { unoptimized: true },
}

export default nextConfig
