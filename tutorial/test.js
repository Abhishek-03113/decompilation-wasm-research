// path module
const path = require("path");
// console.log(path.sep);

let path_ = path.join("/home/apex/", "Projects");

// console.log(path_);

// console.log(path.basename(path_));
// console.log(path.dirname(""));

const abs = path.resolve(__dirname, "content", "subfolder");
// console.log(abs);

// http module
const { readFileSync, writeFileSync } = require("fs");
const os = require("os");

read = readFileSync("./hello.txt", "utf8");

writeFileSync("./hello.txt", `Here is what we read from the file : ${read}`);

// console.log(read);

// async

const { writeFile, readFile } = require("fs");

readFile("new.txt", "utf-8", (err, result) => {
  if (err) {
    console.log(err);
    return;
  }
  // console.log(result);
  const first = result;
  readFile("./second.txt", "utf-8", (err, result) => {
    if (err) {
      console.log(err);
      return;
    }
    const second = result;

    writeFile(
      "./async.txt",
      `Here is Result : ${first} ${second}`,
      (err, result) => {
        if (err) {
          console.log(err);
          return;
        }
        console.log(result);
      },
    );
    // writeFileSync("./async.txt", `Here is the result ${first}, ${second}`, {
    //   flag: "a",
    // });
  });
});
