// Every test's git, and the git hh itself runs under test, ignores this machine's git hooks: a
// global core.hooksPath (a leak scan on every commit) made the git-heavy tests slow enough to time
// out, and a hook could change what they test. Git reads config from these variables (git 2.31+).
process.env.GIT_CONFIG_COUNT = '1';
process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
process.env.GIT_CONFIG_VALUE_0 = '/dev/null';
