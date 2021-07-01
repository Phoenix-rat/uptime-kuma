
const dayjs = require("dayjs");
const utc = require('dayjs/plugin/utc')
var timezone = require('dayjs/plugin/timezone')
dayjs.extend(utc)
dayjs.extend(timezone)
const axios = require("axios");
const {tcping, ping} = require("../util-server");
const {R} = require("redbean-node");
const {BeanModel} = require("redbean-node/dist/bean-model");


/**
 * status:
 *      0 = DOWN
 *      1 = UP
 */
class Monitor extends BeanModel {

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            url: this.url,
            hostname: this.hostname,
            port: this.port,
            weight: this.weight,
            active: this.active,
            type: this.type,
            interval: this.interval,
            keyword: this.keyword,
        };
    }

    start(io) {
        let previousBeat = null;

        const beat = async () => {
            console.log(`Monitor ${this.id}: Heartbeat`)

            if (! previousBeat) {
                previousBeat = await R.findOne("heartbeat", " monitor_id = ? ORDER BY time DESC", [
                    this.id
                ])
            }

            let bean = R.dispense("heartbeat")
            bean.monitor_id = this.id;
            bean.time = R.isoDateTime(dayjs.utc());
            bean.status = 0;

            // Duration
            if (previousBeat) {
                bean.duration = dayjs(bean.time).diff(dayjs(previousBeat.time), 'second');
            } else {
                bean.duration = 0;
                console.log(previousBeat)
            }

            try {
                if (this.type === "http" || this.type === "keyword") {
                    let startTime = dayjs().valueOf();
                    let res = await axios.get(this.url)
                    bean.msg = `${res.status} - ${res.statusText}`
                    bean.ping = dayjs().valueOf() - startTime;

                    if (this.type === "http") {
                        bean.status = 1;
                    } else {

                        if (res.data.includes(this.keyword)) {
                            bean.msg += ", keyword is found"
                            bean.status = 1;
                        } else {
                            throw new Error(bean.msg + ", but keyword is not found")
                        }

                    }


                } else if (this.type === "port") {
                    bean.ping = await tcping(this.hostname, this.port);
                    bean.status = 1;

                } else if (this.type === "ping") {
                    bean.ping = await ping(this.hostname);
                    bean.status = 1;
                }

            } catch (error) {
                bean.msg = error.message;
            }

            // Mark as important if status changed
            if (! previousBeat || previousBeat.status !== bean.status) {
                bean.important = true;
            } else {
                bean.important = false;
            }

            io.to(this.user_id).emit("heartbeat", bean.toJSON());

            await R.store(bean)
            Monitor.sendStats(io, this.id, this.user_id)

            previousBeat = bean;
        }

        beat();
        this.heartbeatInterval = setInterval(beat, this.interval * 1000);
    }

    stop() {
        clearInterval(this.heartbeatInterval)
    }

    static async sendStats(io, monitorID, userID) {
        Monitor.sendAvgPing(24, io, monitorID, userID);
        Monitor.sendUptime(24, io, monitorID, userID);
        Monitor.sendUptime(24 * 30, io, monitorID, userID);
    }

    /**
     *
     * @param duration : int Hours
     */
    static async sendAvgPing(duration, io, monitorID, userID) {
        let avgPing = parseInt(await R.getCell(`
            SELECT AVG(ping)
            FROM heartbeat
            WHERE time > DATE('now', ? || ' hours')
            AND ping IS NOT NULL
            AND monitor_id = ? `, [
            -duration,
            monitorID
        ]));

        io.to(userID).emit("avgPing", monitorID, avgPing);
    }

    /**
     *
     * @param duration : int Hours
     */
    static async sendUptime(duration, io, monitorID, userID) {
        let sec = duration * 3600;

        let downtimeList = await R.getAll(`
            SELECT duration, time
            FROM heartbeat
            WHERE time > DATE('now', ? || ' hours')
            AND status = 0
            AND monitor_id = ? `, [
            -duration,
            monitorID
        ]);

        let downtime = 0;

        for (let row of downtimeList) {
            let value = parseInt(row.duration)
            let time = row.time

            // Handle if heartbeat duration longer than the target duration
            // e.g.   Heartbeat duration = 28hrs, but target duration = 24hrs
            if (value <= sec) {
                downtime += value;
            } else {
                console.log("Now: " + dayjs.utc());
                console.log("Time: " + dayjs(time))

                let trim = dayjs.utc().diff(dayjs(time), 'second');
                console.log("trim: " + trim);
                value = sec - trim;

                if (value < 0) {
                    value = 0;
                }
                downtime += value;
            }
        }

        let uptime = (sec - downtime) / sec;

        if (uptime < 0) {
            uptime = 0;
        }

        io.to(userID).emit("uptime", monitorID, duration, uptime);
    }
}

module.exports = Monitor;