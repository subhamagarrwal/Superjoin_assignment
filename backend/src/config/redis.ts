import Redis from "ioredis"
import dotenv from "dotenv";
import pino from "pino";

dotenv.config();

const logger = pino();
const client = new Redis(process.env.REDIS_URL);


client.on("connect", ()=>{
    logger.info("Connected to Redis");
});
client.on("error", (err)=>{
    logger.error("Redis connection error", err);
});

export default client;