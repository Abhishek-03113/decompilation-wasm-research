const os = require("os");

let user = () => {
  userinfo = os.userInfo();
  console.log(`The current user of the system is ${userinfo.username}`);
};
let uptime = () => {
  let hr = Math.floor(os.uptime() / 3600);

  let min = Math.floor((os.uptime() / 60) % 60);

  console.log(`Systems up for ${hr} hours and ${min} minutes`);
};

const neofetch = {
  host: os.hostname(),
  name: os.type(),
  release: os.release(),
  totalmem: os.totalmem() / (1024 * 1024 * 1024),
  freemem: os.freemem() / (1024 * 1024 * 1024),
  user: os.userInfo().username,
  uptime: `${Math.floor(os.uptime() / 3600)} hrs  ${Math.floor((os.uptime() / 60) % 60)} mins`,
};

console.log(neofetch);
