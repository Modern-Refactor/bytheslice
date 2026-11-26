// tests/setup-shop/index.js
// Runs the setup-shop script tests (write-config, detect-ci) when Node receives the setup-shop test directory.
'use strict';

require('./write-config.test.js');
require('./detect-ci.test.js');
