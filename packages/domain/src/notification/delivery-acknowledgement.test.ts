import { describe, expect, it } from 'vitest';

import {
  type DeliveryAcknowledgement,
  deliveryAcknowledgements,
  describeAcknowledgement,
  isDeliveredAcknowledgement,
  isFailureAcknowledgement,
  isReadAcknowledgement,
  isDeliveryAcknowledgement,
  mergeAcknowledgements,
} from './delivery-acknowledgement';

const allAcknowledgements: DeliveryAcknowledgement[] = [
  deliveryAcknowledgements.error,
  deliveryAcknowledgements.pending,
  deliveryAcknowledgements.server,
  deliveryAcknowledgements.device,
  deliveryAcknowledgements.read,
  deliveryAcknowledgements.played,
];

describe('acknowledgement values', () => {
  it('matches the values the provider reports', () => {
    expect(deliveryAcknowledgements).toEqual({
      error: -1,
      pending: 0,
      server: 1,
      device: 2,
      read: 3,
      played: 4,
    });
  });

  it('names every acknowledgement', () => {
    expect(allAcknowledgements.map((value) => describeAcknowledgement(value))).toEqual([
      'ERROR',
      'PENDING',
      'SERVER',
      'DEVICE',
      'READ',
      'PLAYED',
    ]);
  });

  it('recognises known values and rejects unknown ones', () => {
    for (const value of allAcknowledgements) {
      expect(isDeliveryAcknowledgement(value)).toBe(true);
    }
    for (const value of [-2, 5, 99, 1.5]) {
      expect(isDeliveryAcknowledgement(value)).toBe(false);
    }
  });
});

describe('mergeAcknowledgements', () => {
  it('keeps the highest value, because acknowledgements arrive out of order', () => {
    expect(
      mergeAcknowledgements(deliveryAcknowledgements.read, deliveryAcknowledgements.server),
    ).toBe(deliveryAcknowledgements.read);
    expect(
      mergeAcknowledgements(deliveryAcknowledgements.server, deliveryAcknowledgements.read),
    ).toBe(deliveryAcknowledgements.read);
  });

  it('is idempotent, because the provider redelivers webhooks', () => {
    for (const value of allAcknowledgements) {
      expect(mergeAcknowledgements(value, value)).toBe(value);
    }
  });

  it('never moves backwards', () => {
    let current: DeliveryAcknowledgement = deliveryAcknowledgements.pending;

    for (const incoming of [
      deliveryAcknowledgements.device,
      deliveryAcknowledgements.server,
      deliveryAcknowledgements.pending,
      deliveryAcknowledgements.read,
      deliveryAcknowledgements.server,
    ]) {
      const next = mergeAcknowledgements(current, incoming);
      expect(next).toBeGreaterThanOrEqual(current);
      current = next;
    }

    expect(current).toBe(deliveryAcknowledgements.read);
  });

  it('treats an error as sticky, since a failure is not undone by a later ack', () => {
    expect(
      mergeAcknowledgements(deliveryAcknowledgements.error, deliveryAcknowledgements.read),
    ).toBe(deliveryAcknowledgements.error);
    expect(
      mergeAcknowledgements(deliveryAcknowledgements.read, deliveryAcknowledgements.error),
    ).toBe(deliveryAcknowledgements.error);
  });
});

describe('acknowledgement interpretation', () => {
  it('treats reaching the device as delivered', () => {
    expect(isDeliveredAcknowledgement(deliveryAcknowledgements.device)).toBe(true);
    expect(isDeliveredAcknowledgement(deliveryAcknowledgements.read)).toBe(true);
    expect(isDeliveredAcknowledgement(deliveryAcknowledgements.played)).toBe(true);
  });

  it('does not treat reaching the server as delivered to the recipient', () => {
    expect(isDeliveredAcknowledgement(deliveryAcknowledgements.server)).toBe(false);
    expect(isDeliveredAcknowledgement(deliveryAcknowledgements.pending)).toBe(false);
  });

  it('reports read only for read and played', () => {
    expect(isReadAcknowledgement(deliveryAcknowledgements.read)).toBe(true);
    expect(isReadAcknowledgement(deliveryAcknowledgements.played)).toBe(true);
    expect(isReadAcknowledgement(deliveryAcknowledgements.device)).toBe(false);
  });

  it('treats only an explicit error as a failure', () => {
    // A missing read receipt is not a failure: the recipient may simply have
    // read receipts turned off, and counting that as failed delivery would
    // misreport a large share of healthy traffic.
    expect(isFailureAcknowledgement(deliveryAcknowledgements.error)).toBe(true);

    const nonErrorAcknowledgements = allAcknowledgements.filter(
      (candidate) => candidate !== deliveryAcknowledgements.error,
    );
    for (const value of nonErrorAcknowledgements) {
      expect(isFailureAcknowledgement(value)).toBe(false);
    }
  });

  it('never treats a delivered message as failed just because it was not read', () => {
    expect(isDeliveredAcknowledgement(deliveryAcknowledgements.device)).toBe(true);
    expect(isFailureAcknowledgement(deliveryAcknowledgements.device)).toBe(false);
    expect(isReadAcknowledgement(deliveryAcknowledgements.device)).toBe(false);
  });
});
