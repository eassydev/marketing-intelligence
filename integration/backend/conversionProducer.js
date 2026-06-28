// Drop into BackendNew at e.g. helper/conversionProducer.js (CommonJS).
// Builds the canonical conversion payload from a paid booking and emits it.
// CALL SITE: immediately AFTER `await transaction.commit()` at each transition
// into payment_status='paid', wrapped so it can never affect the payment flow:
//
//   try { await emitBookingPaid(decrypt(booking.id), 'webhook'); } catch (e) { logger.error(e); }
//
// Choke points (confirm anchors against current code):
//   controllers/admin/bookingController.js → handlePaymentSuccess (~1581)
//   version/customer/v3.0.0/controllers/bookingController.js → createBooking (~239),
//     bookingCheckAndUpdatePartiallyPaid (~2625), getBookingUpdateAdditionalCost (~2804)

const { Op } = require('sequelize');
const { decrypt } = require('../middleware/encryption'); // confirm path
const Booking = require('../models/bookingModel'); // confirm path
const { emitConversion } = require('./milClient');

// action_source: 'website' | 'app' | 'system_generated'
async function emitBookingPaid(bookingId, actionSource) {
  const booking = await Booking.findByPk(bookingId); // already-decrypted numeric id
  if (!booking || booking.payment_status !== 'paid') return;

  const userId = Number(decrypt(booking.user_id));

  // First order = no prior PAID booking for this user (always deleted_at IS NULL).
  const priorPaid = await Booking.count({
    where: {
      user_id: userId,
      payment_status: 'paid',
      deleted_at: null,
      id: { [Op.ne]: bookingId },
    },
  });

  // city/category: derive from the booking-item include tree (rate card → category;
  // address → city). Reuse the include the webhook already eager-loads. TODO: wire.
  const { city, category } = await deriveCityCategory(booking);

  await emitConversion({
    app: 'services',
    order_id: String(bookingId), // stable idempotency key
    user_id: userId,
    value_inr: Number(booking.total_amount),
    is_first_order: priorPaid === 0,
    city: city || null,
    category: category || null,
    action_source: actionSource,
    occurred_at: new Date(Number(booking.created_at) * 1000).toISOString(), // created_at is unix seconds
    session_id: booking.mil_sid || null, // if you persist the forwarded web session id
  });
}

// TODO: implement using the existing booking-item / rate-card / address includes.
async function deriveCityCategory(_booking) {
  return { city: null, category: null };
}

module.exports = { emitBookingPaid };
