const Emitter = require("events");
const util = require("util");

// Default resolution is 1ms
const DEFAULT_RESOLUTION = 1e6;
let resolutionDivisor = DEFAULT_RESOLUTION;

// All APIs will be added to `exportable`, which is lastly
// assigned as the value of module.exports
let exportable = new Emitter();

// Object containing callback queues, keys are time in MS
let queue = {};

// Actively processing queue
let isProcessing = false;

let tick = global.setImmediate || process.nextTick;

let hrTime = () => {
  let hrtime = process.hrtime();
  return Math.floor((hrtime[0] * 1e9 + hrtime[1]) / resolutionDivisor);
};

// Store the last event time
let gLast = hrTime();

/**
 * Task create a temporal task item
 * @param {Object} entry Options for entry {time, task}
 */
function Task(entry) {
  if (!(this instanceof Task)) {
    return new Task(entry);
  }

  this.called = 0;
  this.now = this.calledAt = hrTime();

  if (resolutionDivisor !== DEFAULT_RESOLUTION) {
    entry.time = ~~(entry.time * (DEFAULT_RESOLUTION / resolutionDivisor));
  }

  // Side table property definitions
  this.isRunnable = true;
  this.later = this.now + entry.time;
  this.task = entry.task;
  this.type = entry.type;
  this.time = entry.time;

  if (this.later > gLast) {
    gLast = this.later;
  }

  if (!queue[this.later]) {
    queue[this.later] = [];
  }
  // console.log( entry.later, this );
  queue[this.later].push(this);
}

// Inherit EventEmitter API
util.inherits(Task, Emitter);

/**
 * Task.deriveOp (reduction)
 * (static)
 */
Task.deriveOp = function(p, v) {
  return v !== "task" ? v : p;
};


/**
 * stop Stop the current behaviour
 */
Task.prototype.stop = function() {
  this.isRunnable = false;
  this.emit("stop");
};

function Queue(tasks) {
  this.refs = [];
  this.add(tasks);
}

util.inherits(Queue, Emitter);

Queue.prototype.stop = function() {
  this.refs.forEach(function(ref) {
    ref.stop();
  });

  this.emit("stop");
};

Queue.prototype.add = function(tasks) {
  this.cumulative = this.cumulative || 0;

  while (tasks.length) {
    let item = tasks.shift();
    let op = Object.keys(item).reduce(Task.deriveOp, "");
    let ref;

    this.cumulative += item[op];

    // For the last task, ensure that an "end" event is
    // emitted after the final callback is called.
    if (tasks.length === 0) {
      let task = item.task;
      item.task = temporald => {
        task.call(this, temporald);

        // Emit the end event _from_ within the _last_ task
        // defined in the Queue tasks. Use the |tasks| array
        // object as the access key.
        this.emit("end", temporald);

        // Reset on last one in the queue
        this.cumulative = 0;
      };
    }

    if (op === "loop" && tasks.length === 0) {
      // When transitioning from a "delay" to a "loop", allow
      // the loop to iterate the amount of time given,
      // but still start at the correct offset.
      ref = exportable.delay(this.cumulative - item[op], () => {
        ref = exportable.loop(item[op], item.task);

        this.refs.push(ref);
      });
    } else {
      ref = exportable[op](this.cumulative, item.task);
    }

    this.refs.push(ref);
  }
};

exportable.queue = function(tasks) {
  let queue = new Queue(tasks);
  processQueue();
  return queue;
};

let previousTime = hrTime();

function processQueue() {

  if (!isProcessing) {
    isProcessing = true;
    exportable.emit("busy");
  }

  let now = hrTime();
  let entries = [];
  let callProcessQueue = true;

  // Nothing scheduled, don't call processQueue again
  if (gLast <= now) {
    callProcessQueue = false;
  }

  for (let i = previousTime; i <= now; i++) {
    // Accumlate entries
    if (queue[i] && queue[i].length) {
      entries.push(...queue[i]);
    }
  }

  if (entries.length) {

    // console.log(now, entries);
    // console.log( entries );
    while (entries.length) {
      // Shift the entry out of the current list
      let entry = entries.shift();

      // Execute the entry's callback, with
      // "entry" as first arg
      if (entry.isRunnable) {
        entry.called++;
        entry.calledAt = now;
        entry.task.call(entry, entry);
      }

      // Additional "loop" handling
      if (entry.type === "loop" && entry.isRunnable) {
        // There is an active loop, so keep the
        // processQueue active.
        callProcessQueue = true;

        // Calculate the next execution time
        entry.later = now + entry.time;

        // With sub-millisecond wait times, it's conceivable that the clock
        // may have passed our next task time so make sure it runs
        if (entry.later > gLast) {
          gLast = entry.later;
        }

        // Create a queue entry if none exists
        if (!queue[entry.later]) {
          queue[entry.later] = [];
        }

        if (entry.isRunnable) {
          // Push the entry into the queue
          queue[entry.later].push(entry);
        }
      }
    }

    // Cleanup
    for (let i = previousTime; i <= now; i++) {
      delete queue[i];
    }

    entries.length = 0;
  }

  previousTime = now;

  if (callProcessQueue) {
    tick(processQueue);
  } else {
    isProcessing = false;
    exportable.emit("idle");
  }
}

["loop", "delay"].forEach(function(type) {
  exportable[type] = function(time, operation) {
    if (typeof time === "function") {
      operation = time;
      time = 10;
    }
    var task = new Task({
      time: time,
      type: type,
      task: operation
    });

    if (!isProcessing) {
      processQueue();
    }

    return task;
  };
});

// Alias "delay" as "wait" or "defer" (back compat with old compulsive API)
// These aid only in user code that desires clarity in purpose.
// Certain practical applications might be suited to
// "defer" or "wait" vs. "delay"
//
exportable.wait = exportable.defer = exportable.delay;

exportable.repeat = function(n, ms, callback) {
  return exportable.loop(ms, function(context) {
    callback(context);

    if (context.called === n) {
      this.stop();
    }
  });
};

exportable.clear = function() {
  isProcessing = false;
  exportable.removeAllListeners();
  queue = {};
};

exportable.resolution = function(value) {
  if (value === 0.1 || value === 0.01) {
    resolutionDivisor = 1e6 * value;
  } else {
    resolutionDivisor = 1e6;
  }
  previousTime = hrTime();
};

module.exports = exportable;
