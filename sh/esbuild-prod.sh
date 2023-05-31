#!/usr/bin/env bash
# Note: The shebang seems to prevent this error (https://github.com/evanw/esbuild/issues/1703).
# @see https://esbuild.github.io/api/#define
./node_modules/.bin/esbuild ./src/cli.ts --platform=node --bundle --outfile=./dist/cli.js --loader:.html=text --sourcemap --define:ESBUILD_NODE_ENV=\"production\"