db.getSiblingDB("admin").createUser({
  user: process.env.MONGO_APP_USER,
  pwd: process.env.MONGO_APP_PASSWORD,
  roles: [
    { role: "readWrite", db: "shop" },
    { role: "readWrite", db: "blackbox" },
  ],
});
