module.exports = {
  apps: [
    {
      name: 'ai-voice-pbx-engine',
      script: 'node_modules/.bin/tsx',
      args: 'server.ts',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
