'use strict';

/**
 * Service Bus Automation Worker for Enterprise IT Helpdesk.
 *
 * Consumes background jobs from queue 'helpdesk-automation-jobs':
 * - Automatic IT provisioning tasks
 * - Priority SLA escalations
 * - Out-of-band notification dispatches
 *
 * Implements idempotency via processed message deduplication tracking.
 */

class ServiceBusAutomationWorker {
  constructor(options = {}) {
    this.connectionString = options.connectionString || process.env.SERVICEBUS_CONNECTION_STRING;
    this.queueName = options.queueName || 'helpdesk-automation-jobs';
    // Fallback idempotency guard: kept ONLY for jobs that never reach the
    // governed lifecycle (legacy queue paths). Governed actions get their
    // idempotency from the lifecycle claim, which survives restarts/replicas.
    this.processedMessageIds = new Set();
    // Optional lifecycle bridge: { lifecycle, buildMessage(job), actor }.
    // When present, governed jobs execute through the durable pipeline and the
    // worker only reports the outcome — it never executes anything itself.
    this.lifecycleBridge = options.lifecycleBridge || null;
    this.running = false;
  }

  async processJob(job) {
    if (!job || !job.id) {
      throw new Error('Invalid job payload: missing job.id');
    }

    if (this.lifecycleBridge && typeof this.lifecycleBridge.isGoverned === 'function'
      && this.lifecycleBridge.isGoverned(job)) {
      const out = await this.lifecycleBridge.execute(job, this);
      return { status: out.governedStatus, jobId: job.id, governed: out.governed, ...out.detail };
    }

    // Idempotency check
    if (this.processedMessageIds.has(job.id)) {
      return { status: 'duplicate_skipped', jobId: job.id };
    }

    switch (job.type) {
      case 'provision_access':
        // Handle user/group provisioning automation
        break;
      case 'escalate_ticket':
        // Handle SLA escalation
        break;
      case 'dispatch_alert':
        // Dispatch notifications
        break;
      default:
        // Generic job execution
        break;
    }

    this.processedMessageIds.add(job.id);
    return { status: 'completed', jobId: job.id, executedAt: new Date().toISOString() };
  }

  async start() {
    this.running = true;
    return this.running;
  }

  async stop() {
    this.running = false;
    return this.running;
  }
}

module.exports = { ServiceBusAutomationWorker };
