# Quickly test without waiting 30s for better-sqlite to build sqlite.

# Remove prev run.
npm uninstall -g durafetch
rm -rf /tmp/durafetch-cli-test
mkdir /tmp/durafetch-cli-test

# Copy only files that would be committed (do not git clone to take working copy changes).
git ls-files | xargs -I{} rsync -R '{}' /tmp/durafetch-cli-test

# Include Untracked too (currently being edited).
git ls-files --others --exclude-standard | xargs -I{} rsync -R '{}' /tmp/durafetch-cli-test

# Simulate `npm install` - copy files instead of remotely downloading them again to increase speed.
rsync -a node_modules /tmp/durafetch-cli-test

# `npm install ./local-dir` expects any `package.bin` files to exist otherwise the global PATH is not update.
# - But: it will not download node_modules OR run `postinstall`
# - Fix: Just copy the dist.
rsync -a dist /tmp/durafetch-cli-test



# Note: When installing from a local directory, node_modules are not installed. But with a tar file, they are.
npm install --global /tmp/durafetch-cli-test
