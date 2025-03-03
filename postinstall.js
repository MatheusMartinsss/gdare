const { execSync } = require('child_process');

try {
  // Create Puppeteer cache directory
  execSync('mkdir -p /opt/render/.cache/puppeteer', { stdio: 'inherit' });
  
  // Install Chrome
  execSync('node node_modules/puppeteer/install.js', { stdio: 'inherit' });
} catch (error) {
  console.error('Postinstall failed:', error);
  process.exit(1);
}