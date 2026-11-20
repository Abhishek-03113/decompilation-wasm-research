#!/bin/sh
# Builds PPSSPP for the browser and copies the result into public/build/.
#
#   sh build.sh [work-dir]          (default work dir: ./.work)
#
# Needs git, cmake, ninja, python3 and bun (to serve it). Downloads the Emscripten SDK (~1 GB) into the work dir.
# Takes about 30-40 minutes on 4 cores the first time; later runs are incremental.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${1:-$HERE/.work}
PPSSPP_COMMIT=7710606
SDL_TAG=release-3.4.2   # the version Emscripten's sdl3 port expects
mkdir -p "$WORK"
cd "$WORK"

# 1. Emscripten
if [ ! -d emsdk ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git
  (cd emsdk && ./emsdk install latest && ./emsdk activate latest)
fi
# emsdk_env.sh can only find itself under sh/dash when sourced from inside its own folder.
cd "$WORK/emsdk" && . ./emsdk_env.sh >/dev/null && cd "$WORK"
command -v emcmake >/dev/null || { echo "emsdk_env.sh did not set up Emscripten" >&2; exit 1; }

# 2. SDL3 from git. Emscripten's port would download a release archive instead; this also works
#    behind proxies that block archive downloads.
[ -d SDL ] || git clone --depth 1 -b "$SDL_TAG" https://github.com/libsdl-org/SDL.git SDL
export EMCC_LOCAL_PORTS="sdl3=$WORK/SDL"

# 3. PPSSPP at a known commit, plus the submodules the build uses, plus our patches.
if [ ! -d ppsspp ]; then
  git clone https://github.com/hrydgard/ppsspp.git
  cd ppsspp
  git checkout -q "$PPSSPP_COMMIT"
  for m in ext/glslang ext/SPIRV-Cross ext/rapidjson ext/zstd ext/cpu_features ext/rcheevos \
           ext/libchdr ext/lua ext/freetype ext/nanosvg ext/armips ext/miniupnp ext/discord-rpc \
           ext/aemu_postoffice ext/OpenXR-SDK; do
    git submodule update --init --depth 1 "$m"
  done
  (cd ext/armips && git submodule update --init --depth 1)
  git apply "$HERE/patches/ppsspp-wasm.patch"
  (cd ext/aemu_postoffice && git apply "$HERE/patches/aemu_postoffice-wasm.patch")
  cd ..
fi

# 4. Configure and build the SDL frontend for WebAssembly.
cd ppsspp
emcmake cmake -B build-web -G Ninja -Wno-dev \
  -DCMAKE_BUILD_TYPE=Release -DX86=OFF -DX86_64=OFF \
  -DHEADLESS=OFF -DHEADLESS_CROSS:BOOL=OFF -DUSING_GLES2=ON \
  -DUSE_DISCORD=OFF -DUSE_MINIUPNPC=OFF -DUSE_SYSTEM_LIBPNG=OFF -DUSE_FFMPEG=OFF \
  -DUSE_NO_MMAP=ON -DUSE_CCACHE=OFF -DUNITTEST=OFF -DATLAS_TOOL=OFF \
  -DWASM_DEBUG="${WASM_DEBUG:-OFF}"
ninja -C build-web PPSSPPSDL

# 5. Copy the output next to the page.
mkdir -p "$HERE/public/build"
cp build-web/PPSSPPSDL.js build-web/PPSSPPSDL.wasm build-web/PPSSPPSDL.data "$HERE/public/build/"
echo "Done. Start the server with: cd $HERE && bun install && bun start"
