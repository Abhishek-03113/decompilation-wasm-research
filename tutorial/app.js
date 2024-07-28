const os = require("os");

console.log(os.uptime());

let uptime = () => {
  let hr = Math.floor(os.uptime() / 3600);

  let min = Math.floor((os.uptime() / 60) % 60);

  console.log(`Systems up for ${hr} hours and ${min} minutes`);
};

uptime();
