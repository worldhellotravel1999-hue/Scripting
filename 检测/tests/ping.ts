import { Script } from "scripting"

const value = { hello: "world", passed: 2 }
console.log("[ping] project run", JSON.stringify(value))
Script.exit(value)
