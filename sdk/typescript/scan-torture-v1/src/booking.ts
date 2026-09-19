// HIGH: booking side effect
export async function reserveHotel() {
  return createBooking({
    hotelId: "H123"
  });
}
