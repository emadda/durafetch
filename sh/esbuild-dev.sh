./node_modules/.bin/esbuild ./src/cli.ts --platform=node --bundle --outfile=./dist/cli.js --loader:.html=text --watch --sourcemap --define:ESBUILD_NODE_ENV=\"development\"
