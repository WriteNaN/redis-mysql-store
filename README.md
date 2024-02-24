### Simple Redis & Mysql client keystore with built-in caching

#### Why Use This Library?
caching data is really important for apps that require low-latency, such as games. it has never been easier to do this!

#### Installation:
```npm install redis-mysql-store```

Example Usage:
```js
const Database = require("redis-mysql-store").default;
//import Database from "redis-mysql-store";

const db = new Database({
    redisURI: "",
    sqlURI: "",
    config: {
        debug: true,
        redisAutoTempFlushInterval: 60*60, // auto removes all keys starting with temp: on this interval. (ms) - manually called from client
        defaultExpire: 400 // otherwise default expire (timeout handled by server)
    }
});
```

now you can use db.set, db.get, db.delete, db.redis, db.sql and/or even interact directly with the client (MYSQL2 CONNECTION/REDIS CLIENT). (db.mysqlClient, db.redisClient).

find more options and config from types.

Happy Coding! <3