/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

"use strict";

// dep: geo.base
// dep: geo.polygons
// dep: kiri-mode.cam.driver
gapp.register("kiri-mode.cam.export", [], (root, exports) => {

const { base, kiri } = root;
const { polygons, util } = base;
const { driver } = kiri;
const { CAM } = driver;

const POLY = polygons;
const PRO = CAM.process;

/**
 * @returns {Array} gcode lines
 */
CAM.export = function(print, online) {
    const widget = print.widgets[0];
    if (!widget) return;

    const { settings } = print;
    const { device, tools } = settings;

    let i,
        time = 0,
        lines = 0,
        bytes = 0,
        opnum = 0,
        factor = 1,
        output = [],
        spindle = 0,
        newSpindle = 0,
        spindleMax = device.spindleMax,
        origin = settings.origin || { x: 0, y: 0, z: 0 },
        space = device.gcodeSpace ? ' ' : '',
        isRML = device.gcodeFExt.toLowerCase() === 'rml',
        stripComments = device.gcodeStrip || false,
        cmdToolChange = device.gcodeChange || [ "M6 T{tool}" ],
        cmdSpindle = device.gcodeSpindle || [ "M3 S{speed}" ],
        cmdDwell = device.gcodeDwell || [ "G4 P{time}" ],
        dev = settings.device,
        spro = settings.process,
        maxZd = spro.camFastFeedZ,
        maxXYd = spro.camFastFeed,
        decimals = base.config.gcode_decimals || 4,
        pos = { x:null, y:null, z:null, f:null, t:null },
        line,
        cidx,
        mode,
        point,
        points = 0,
        stock = settings.stock || { },
        hasStock = spro.camStockOn && stock.x && stock.y && stock.z,
        ztOff = hasStock ? stock.z - widget.track.top : 0,
        bounds = widget.getBoundingBox(),
        zmax = hasStock ? stock.z : bounds.max.z,
        runbox = {
            max: { x:-Infinity, y:-Infinity, z:-Infinity},
            min: { x:Infinity, y:Infinity, z:Infinity}
        },
        offset = {
            x: -origin.x,
            y:  origin.y
        },
        consts = {
            tool: 0,
            tool_name: "unknown",
            top: (offset ? dev.bedDepth : dev.bedDepth/2),
            left: (offset ? 0 : -dev.bedWidth/2),
            right: (offset ? dev.bedWidth : dev.bedWidth/2),
            bottom: (offset ? 0 : -dev.bedDepth/2),
            time_sec: 0,
            time_ms: 0,
            time: 0
        }

    function section(section) {
        append();
        online({ section });
    }

    function append(line) {
        if (line) {
            lines++;
            bytes += line.length;
            output.append(line);
        }
        if (!line || output.length > 1000) {
            online(output.join("\r\n"));
            output = [];
        }
    }

    function filterEmit(array, consts) {
        if (!array) return;
        for (i=0; i<array.length; i++) {
            line = print.constReplace(array[i], consts);
            if (!isRML && stripComments && (cidx = line.indexOf(";")) >= 0) {
                line = line.substring(0, cidx).trim();
                if (line.length === 0) continue;
            }
            if (line.indexOf('G20') === 0) {
                factor = 1/25.4;
                consts.top = (offset ? dev.bedDepth : dev.bedDepth/2) * factor;
                consts.left = (offset ? 0 : -dev.bedWidth/2) * factor;
                consts.right = (offset ? dev.bedWidth : dev.bedWidth/2) * factor;
                consts.bottom = (offset ? 0 : -dev.bedDepth/2) * factor;
            } else if (line.indexOf('G21') === 0) {
                factor = 1;
            }
            append(line);
        }
    }

    function add0(val, opt) {
        let s = val.toString(),
            d = s.indexOf(".");
        if (d < 0) {
            return opt ? s : s + '.0';
        } else {
            return val.toFixed(decimals);
        }
    }

    function toolByNumber(number) {
        for (let i=0; i<tools.length; i++) {
            if (tools[i].number === number) return tools[i];
        }
        return undefined;
    }

    function toolNameByNumber(number) {
        for (let i=0; i<tools.length; i++) {
            if (tools[i].number === number) return tools[i].name;
        }
        return "unknown";
    }

    function moveTo(out) {
        let newpos = out.point;

        // no point == dwell
        // out.speed = time to dwell in ms
        if (!newpos) {
            time += out.speed / 60;
            consts.time_sec = out.speed / 1000;
            consts.time_ms = out.speed;
            consts.time = consts.time_sec;
            filterEmit(cmdDwell, consts);
            return;
        }

        newpos.x = util.round(newpos.x, decimals);
        newpos.y = util.round(newpos.y, decimals);
        newpos.z = util.round(newpos.z, decimals);

        // on tool change
        let changeTool = out.tool != pos.t;
        if (changeTool) {
            pos.t = out.tool;
            consts.tool = pos.t;
            consts.tool_name = toolNameByNumber(out.tool);
            filterEmit(cmdToolChange, { ...consts, spindle: newSpindle } );
        }

        // on spindle change (deferred from layer transition so it's post-toolchange)
        if ((changeTool && spindleMax) || (newSpindle && newSpindle !== spindle)) {
            spindle = newSpindle;
            if (spindle > 0) {
                let speed = Math.abs(spindle);
                filterEmit(cmdSpindle, { speed, spindle: speed, rpm: speed });
            } else {
                append("M4");
            }
        }

        // first point out sets the current position (but not Z)
        // hacky AF way to split initial x,y,z into z then x,y
        if (points === 0) {
            pos.x = pos.y = pos.z = 0;
            points++;
            moveTo({
                tool: out.tool,
                point: { x: 0, y: 0, z: newpos.z }
            });
            moveTo({
                tool: out.tool,
                point: { x: newpos.x, y: newpos.y, z: newpos.z }
            });
            points--;
            return;
        }

        let speed = out.speed,
            nl = [speed ? 'G1' : 'G0'],
            dx = newpos.x - pos.x,
            dy = newpos.y - pos.y,
            dz = newpos.z - pos.z,
            maxf = dz ? maxZd : maxXYd,
            feed = Math.min(speed || maxf, maxf),
            dist = Math.sqrt(dx * dx + dy * dy + dz * dz),
            newFeed = feed && feed !== pos.f;

        // drop dup points (all deltas are 0)
        if (!(dx || dy || dz)) {
            return;
        }

        if (newpos.x !== pos.x) {
            pos.x = newpos.x;
            runbox.min.x = Math.min(runbox.min.x, pos.x);
            runbox.max.x = Math.max(runbox.max.x, pos.x);
            nl.append(space).append("X").append(add0(pos.x * factor));
        }
        if (newpos.y !== pos.y) {
            pos.y = newpos.y;
            runbox.min.y = Math.min(runbox.min.y, pos.y);
            runbox.max.y = Math.max(runbox.max.y, pos.y);
            nl.append(space).append("Y").append(add0(pos.y * factor));
        }
        if (newpos.z !== pos.z) {
            pos.z = newpos.z;
            runbox.min.z = Math.min(runbox.min.z, pos.z);
            runbox.max.z = Math.max(runbox.max.z, pos.z);
            nl.append(space).append("Z").append(add0(pos.z * factor));
        }
        if (newFeed) {
            pos.f = feed;
            nl.append(space).append("F").append(add0(feed * factor, true));
        }

        // temp hack to support RML1 dialect from a file extensions trigger
        if (isRML) {
            if (speed) {
                if (newFeed) {
                    append(`VS${feed};`);
                }
                nl = [ "Z", add0(pos.x * factor), ",", add0(pos.y * factor), ",", add0(pos.z * factor), ";" ];
            } else {
                nl = [ "PU", add0(pos.x * factor), ",", add0(pos.y * factor), ";" ];
            }
        }

        // update time calculation
        time += (dist / (pos.f || 1000)) * 60;

        // if (comment && !stripComments) {
        //     nl.append(" ; ").append(comment);
        //     nl.append(" ; ").append(points);
        // }
        append(nl.join(''));
        points++;
    }

    section('header');
    if (!stripComments) {
        append(`; Generated by Kiri:Moto ${kiri.version}`);
        append(`; ${new Date().toString()}`);
        filterEmit(["; Bed left:{left} right:{right} top:{top} bottom:{bottom}"], consts);
        if (hasStock) {
            append(`; Stock X:${stock.x.round(2)} Y:${stock.y.round(2)} Z:${stock.z.round(2)}`);
        }
        append(`; Target: ${settings.filter[settings.mode]}`);
        append("; --- process ---");
        for (let pk in spro) {
            if (pk !== "ops" && pk !== "op2") {
                append("; " + pk + " = " + spro[pk]);
            }
        }
    }

    // collect tool info to add to header
    let toolz = {}, ctool;

    // remap points as necessary for origins, offsets, inversions
    print.output.forEach(function(layer) {
        layer.forEach(function(out) {
            if (out.tool && out.tool !== ctool) {
                ctool = toolByNumber(out.tool);
                toolz[out.tool] = ctool;
            }
            point = out.point;
            if (!point || point.mod) return;
            // ensure not point is modified twice
            point.mod = 1;
            if (offset) {
                point.x += offset.x;
                point.y += offset.y;
            }
            if (spro.outputInvertX) point.x = -point.x;
            if (spro.outputInvertY) point.y = -point.y;
            if (spro.camOriginTop) point.z = point.z - zmax;
        });
    });

    if (!stripComments) {
        // emit tools used in comments
        append("; --- tools ---");
        Object.keys(toolz).sort().forEach(tn => {
            let tool = toolz[tn];
            append(`; tool=${tn} flute=${tool.flute_diam} len=${tool.flute_len} metric=${tool.metric}`);
        });
    }

    // emit gcode preamble
    filterEmit(device.gcodePre, consts);

    // emit all points in layer/point order
    for (let layerout of print.output) {
        if (mode !== layerout.mode) {
            if (mode && !stripComments) {
                append("; ending " + mode + " op after " + Math.round(time/60) + " seconds");
            }
            mode = layerout.mode;
            if (mode) {
                section(`op-${opnum++}-${mode}`);
            }
            if (!stripComments) {
                append("; starting " + mode + " op");
            }
        }
        newSpindle = layerout.spindle;
        for (let out of layerout) {
            moveTo(out);
        }
    }

    if (mode && !stripComments) {
        append("; ending " + mode + " op after " + Math.round(time/60) + " seconds");
    }

    // emit gcode post
    section('footer');
    filterEmit(device.gcodePost, consts);

    // flush buffered gcode
    append();

    print.time = time;
    print.lines = lines;
    print.bytes = bytes + lines - 1;
    print.bounds = runbox;
};

});
