import {Table} from "./models/table.model.js"
import TableSession from "./models/table-session.model.js"
import { User } from "./models/user.model.js"
import { Order } from "./models/order.model.js"
import  Bill  from "./models/bill.model.js"
import { getValue, setValue, deleteCache } from './services/redis.service.js'
import logger from './middlewares/logger.middleware.js'

// Redis keys
const KITCHEN_SOCKET_KEY = 'kitchen:socket_id'
const KITCHEN_ORDERS_CACHE = 'kitchen:active_orders'

export const setupSocketIO = (io) => {
  // Store connected table devices
  const connectedTables = new Map()
  // Store connected kitchen devices
  const connectedKitchens = new Map()

  io.on("connection", (socket) => {
    logger.info(`---> SERVER: New socket connection attempt received! ID: ${socket.id}`);
    logger.info(`Socket connected: ${socket.id}`)

    // Table app registers itself with its table ID
    socket.on("register_table", async (data) => {
      try {
        const { tableId } = data

        if (!tableId) {
          socket.emit("error", { message: "Table ID is required" })
          return
        }

        // Validate table exists
        const table = await Table.findOne({ tableId: tableId })
        if (!table) {
          socket.emit("error", { message: "Table not found" })
          return
        }

        // Join a room specific to this table
        socket.join(`table_${tableId}`)

        // Store socket ID with table ID for direct messaging
        connectedTables.set(tableId, socket.id)

        logger.info(`Table ${tableId} registered with socket ID: ${socket.id}`)

        socket.emit("table_registered", {
          success: true,
          message: `Table ${tableId} registered successfully`,
          tableData: {
            id: table._id,
            tableId: table.tableId,
            status: table.status,
            isActive: table.isActive,
          },
        })
      } catch (error) {
        logger.error("Error registering table:", error)
        socket.emit("error", { message: "Failed to register table" })
      }
    })

    // Kitchen app registers itself
    socket.on("register_kitchen", async () => {
      try {
        // Store kitchen socket ID in Redis
        const success = await setValue(KITCHEN_SOCKET_KEY, socket.id)
        if (success) {
          logger.info(`Kitchen app registered with socket ID: ${socket.id} (Stored in Redis)`)
          // Acknowledge registration
          socket.emit("kitchen_registered", { success: true })
          // Optionally, keep joining the room if other logic depends on it
          socket.join("kitchen")
        } else {
          logger.error(`Failed to store kitchen socket ID in Redis for: ${socket.id}`)
          socket.emit("error", { message: "Failed to register kitchen due to Redis error" })
        }
      } catch (error) {
        logger.error("Error registering kitchen:", error)
        socket.emit("error", { message: "Failed to register kitchen" })
      }
    })

    // Handle tablet device registration (example - adapt as needed)
    socket.on("register_device_with_table", async (data) => {
      try {
        const { deviceId } = data
        if (!deviceId) {
          return socket.emit("error", { message: "Device ID is required" })
        }
        
        // Store tablet socket ID in Redis with device ID (or tableId if preferred)
        const key = `device:${deviceId}:socket_id`
        const success = await setValue(key, socket.id)
        if (success) {
          logger.info(`Device ${deviceId} registered with socket ID: ${socket.id} (Stored in Redis)`)
          socket.emit("device_registered", { success: true, deviceId })
        } else {
          logger.error(`Failed to store device socket ID in Redis for: ${deviceId}`)
          socket.emit("error", { message: "Failed to register device due to Redis error" })
        }
      } catch (error) {
        logger.error("Error registering device:", error)
        socket.emit("error", { message: "Failed to register device" })
      }
    })

    // Customer app initiates a session after scanning QR code
    socket.on("initiate_session", async (data) => {
      try {
        const { tableId, userId } = data

        if (!tableId || !userId) {
          socket.emit("error", { message: "Table ID and User ID are required" })
          return
        }

        // Validate table
        const table = await Table.findOne({ tableId: tableId })
        if (!table) {
          socket.emit("error", { message: "Table not found" })
          return
        }

        if (!table.isActive) {
          socket.emit("error", { message: "Table is not active" })
          return
        }

        if (table.status !== "available") {
          socket.emit("error", { message: "Table is not available" })
          return
        }

        // Validate user
        const user = await User.findById(userId)
        if (!user) {
          socket.emit("error", { message: "User not found" })
          return
        }

        // Check if there's an existing active session for this user
        const existingUserSession = await TableSession.findOne({
          clientId: userId,
          status: "active",
        })

        if (existingUserSession) {
          socket.emit("error", {
            message: "You already have an active session at another table",
            sessionId: existingUserSession._id,
            tableId: existingUserSession.tableId,
          })
          return
        }

        // Create a new session
        const session = new TableSession({
          tableId: table._id, // Use the MongoDB _id
          clientId: userId,
          startTime: new Date(),
          status: "active",
        })

        await session.save()

        // Update table status
        table.status = "occupied"
        table.currentSession = session._id
        await table.save()

        // Notify the table app to open the session
        io.to(`table_${tableId}`).emit("session_started", {
          sessionId: session._id,
          tableId: tableId,
          clientId: session.clientId,
          startTime: session.startTime,
          status: session.status,
        })

        // Also notify the customer app
        socket.emit("session_created", {
          sessionId: session._id,
          tableId: tableId,
          startTime: session.startTime,
          status: session.status,
        })

        logger.info(`Session started for table ${tableId} by user ${userId}`)
      } catch (error) {
        logger.error("Error initiating session:", error)
        socket.emit("error", { message: "Failed to initiate session" })
      }
    })

    // Customer app scans QR code
    socket.on("scan_qr_code", async (data) => {
      try {
        const { tableId, userId } = data

        if (!tableId || !userId) {
          socket.emit("error", { message: "Table ID and User ID are required" })
          return
        }

        // Validate table
        const table = await Table.findOne({ tableId: tableId })
        if (!table) {
          socket.emit("error", { message: "Table not found" })
          return
        }

        if (!table.isActive) {
          socket.emit("error", { message: "Table is not active" })
          return
        }

        if (table.status !== "available") {
          socket.emit("error", { message: "Table is not available" })
          return
        }

        // Validate user
        const user = await User.findById(userId)
        if (!user) {
          socket.emit("error", { message: "User not found" })
          return
        }

        // Check if there's an existing active session for this user
        const existingUserSession = await TableSession.findOne({
          clientId: userId,
          status: "active",
        })

        if (existingUserSession) {
          socket.emit("error", {
            message: "You already have an active session at another table",
            sessionId: existingUserSession._id,
            tableId: existingUserSession.tableId,
          })
          return
        }

        // Create a new session
        const session = new TableSession({
          tableId: table._id, // Use the MongoDB _id
          clientId: userId,
          startTime: new Date(),
          status: "active",
        })

        await session.save()

        // Update table status
        table.status = "occupied"
        table.currentSession = session._id
        await table.save()

        // Notify the table app to open the session
        io.to(`table_${tableId}`).emit("session_started", {
          sessionId: session._id,
          tableId: tableId,
          clientId: session.clientId,
          startTime: session.startTime,
          status: session.status,
          customerName: user.fullName || "Customer",
        })

        // Also notify the customer app
        socket.emit("session_created", {
          sessionId: session._id,
          tableId: tableId,
          startTime: session.startTime,
          status: session.status,
        })

        logger.info(`Session started for table ${tableId} by user ${userId} via QR scan`)
      } catch (error) {
        logger.error("Error processing QR code scan:", error)
        socket.emit("error", { message: "Failed to process QR code scan" })
      }
    })

    // Handle order updates to notify table app
    socket.on("order_placed", async (data) => {
      try {
        const { sessionId, orderId, tableId } = data

        if (!orderId) {
          socket.emit("error", { message: "Order ID is required" })
          return
        }

        // Get the order details
        const order = await Order.findById(orderId).populate({
          path: "items.menuItem",
          select: "name image category",
        })

        if (!order) {
          socket.emit("error", { message: "Order not found" })
          return
        }

        // Get table ID if available
        let orderTableId = null
        if (order.TableId) {
          // Find the table with this ID
          const table = await Table.findById(order.TableId)
          if (table) {
            orderTableId = table.tableId
          }
        }

        // Calculate preparation time (for countdown display)
        // const preparationTime = new Date()
        // preparationTime.setMinutes(preparationTime.getMinutes() + 15) // Default 15 min prep time

        // Emit to all connected kitchen clients
        // NOTE: This emission is already handled in the createOrder controller
        // We might only need to emit updates here, not the full new order
        /*
        io.to("kitchen").emit("new_kitchen_order", {
          orderId: order._id,
          orderNumber: order._id.toString().slice(-6).toUpperCase(), // Last 6 chars of ID
          items: order.items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            specialInstructions: item.specialInstructions,
            category: item.menuItem ? item.menuItem.category : null,
            productId: `prod_${item.name}`,
          })),
          orderType: order.orderType,
          tableId: orderTableId,
          status: order.status,
          createdAt: order.createdAt,
          // preparationTime: preparationTime,
        })
        */

        // If sessionId is provided, notify the table app
        if (sessionId && tableId) {
          io.to(`table_${tableId}`).emit("new_order", {
            sessionId,
            orderId: order._id,
            items: order.items.map((item) => ({
              name: item.name,
              quantity: item.quantity,
              price: item.price,
              total: item.total,
            })),
            total: order.total,
            status: order.status,
          })
        }

        logger.info(`Order ${orderId} notification sent to table app (kitchen notified via controller)`)
      } catch (error) {
        logger.error("Error handling order placed:", error)
        socket.emit("error", { message: "Failed to notify about order" })
      }
    })

    // Handle session end request
    socket.on("end_session", async (data) => {
      try {
        const { sessionId, tableId } = data

        if (!sessionId) {
          socket.emit("error", { message: "Session ID is required" })
          return
        }

        // Find the session
        const session = await TableSession.findById(sessionId)
        if (!session) {
          socket.emit("error", { message: "Session not found" })
          return
        }

        if (session.status === "closed") {
          socket.emit("error", { message: "Session is already closed" })
          return
        }

        // Check if bill already exists
        let bill = await Bill.findOne({ tableSessionId: sessionId })

        if (!bill) {
          // Get all orders for this session
          const orders = await Order.find({ _id: { $in: session.orders } })

          // Calculate total
          const total = orders.reduce((sum, order) => sum + order.total, 0)

          // Create bill
          bill = new Bill({
            tableSessionId: sessionId,
            total,
            paymentStatus: "pending",
          })

          await bill.save()
        }

        // Update session status
        session.status = "closed"
        session.endTime = new Date()
        await session.save()

        // Update table status
        const table = await Table.findById(session.tableId)
        if (table) {
          table.status = "cleaning"
          table.currentSession = null
          await table.save()
        }

        // Notify both table app and customer app
        const effectiveTableId = tableId || (table ? table.tableId : null);
        if(effectiveTableId) {
          io.to(`table_${effectiveTableId}`).emit("session_ended", {
            sessionId,
            bill: {
              id: bill._id,
              total: bill.total,
              paymentStatus: bill.paymentStatus,
            },
          })
        }

        // Also emit back to the caller (e.g., Kiosk app)
        socket.emit("session_ended_confirmation", {
          sessionId,
          bill: {
            id: bill._id,
            total: bill.total,
            paymentStatus: bill.paymentStatus,
          },
        })

        logger.info(`Session ${sessionId} ended and bill created`)
      } catch (error) {
        logger.error("Error ending session:", error)
        socket.emit("error", { message: "Failed to end session" })
      }
    })

    // Handle bill creation notification
    socket.on("bill_created", async (data) => {
      try {
        const { billId, sessionId, tableId } = data

        if (!billId || !sessionId) {
          socket.emit("error", { message: "Bill ID and Session ID are required" })
          return
        }

        // Notify the table app about the bill
        io.to(`table_${tableId}`).emit("bill_ready", {
          billId,
          sessionId,
        })

        logger.info(`Bill ${billId} notification sent to table ${tableId}`)
      } catch (error) {
        logger.error("Error handling bill creation:", error)
        socket.emit("error", { message: "Failed to notify about bill" })
      }
    })

    // Handle reservation events
    socket.on("make_reservation", async (data) => {
      try {
        const { userId, tableId, reservationTime } = data

        if (!userId || !tableId || !reservationTime) {
          socket.emit("error", { message: "User ID, Table ID, and reservation time are required" })
          return
        }

        // Notify admin about new reservation request
        io.emit("new_reservation_request", {
          userId,
          tableId,
          reservationTime,
        })

        logger.info(`New reservation request from user ${userId} for table ${tableId}`)
      } catch (error) {
        logger.error("Error handling reservation request:", error)
        socket.emit("error", { message: "Failed to process reservation request" })
      }
    })

    // Handle disconnection
    socket.on("disconnect", async () => {
      logger.info(`Socket disconnected: ${socket.id}`)
      
      // Check if this was the kitchen socket and remove it from Redis
      try {
        const kitchenSocketId = await getValue(KITCHEN_SOCKET_KEY)
        if (kitchenSocketId === socket.id) {
          await deleteCache(KITCHEN_SOCKET_KEY) // Use deleteCache which calls .del()
          logger.info(`Removed disconnected kitchen socket ID from Redis: ${socket.id}`)
        }
        // TODO: Add logic here to remove disconnected device sockets if needed
      } catch (error) {
        logger.error(`Error cleaning up disconnected socket ${socket.id} from Redis:`, error)
      }

      // Remove from connected tables if this was a table app
      for (const [tableId, socketId] of connectedTables.entries()) {
        if (socketId === socket.id) {
          connectedTables.delete(tableId)
          logger.info(`Table with ID ${tableId} disconnected`)
          break
        }
      }

      // Remove from connected kitchens if this was a kitchen app
      for (const [kitchenId, socketId] of connectedKitchens.entries()) {
        if (socketId === socket.id) {
          connectedKitchens.delete(kitchenId)
          logger.info(`Kitchen with ID ${kitchenId} disconnected`)
          break
        }
      }
    })
  })
}

/**
 * Notify kitchen about a new order
 * @param {object} io - Socket.IO server instance
 * @param {object} order - The new order object (mongoose document expected)
 */
export const notifyKitchenAboutNewOrder = async (io, order) => {
  try {
    // Get kitchen socket ID from Redis
    const kitchenSocketId = await getValue(KITCHEN_SOCKET_KEY)
    
    if (!kitchenSocketId) {
      logger.warn("No kitchen app registered, cannot notify about new order")
      return false
    }
    
    // Format order for kitchen display (ensure necessary fields are present)
    const formattedOrder = {
      id: order._id.toString(), // Use _id
      orderNumber: order._id.toString().slice(-6).toUpperCase(),
      items: order.items.map(item => ({
        name: item.name,
        quantity: item.quantity,
        specialInstructions: item.specialInstructions || "",
        // Assuming menuItem might not be populated here, handle gracefully
        category: item.menuItem?.category || null, 
      })),
      orderType: order.orderType,
      // Ensure TableId is populated or handled if not
      tableId: order.TableId?.toString() || order.deviceId || null, // Use deviceId if TableId link isn't there
      status: order.status,
      createdAt: order.createdAt,
      // elapsedTime calculation might be better done on the client 
    }
    
    // Emit event directly to kitchen socket
    io.to(kitchenSocketId).emit("new_kitchen_order", formattedOrder)
    
    // Invalidate kitchen orders cache *after* successful emission
    await deleteCache(KITCHEN_ORDERS_CACHE)
    
    logger.info(`Notified kitchen (${kitchenSocketId}) about new order: ${order._id}`)
    return true
  } catch (error) {
    logger.error(`Error notifying kitchen about new order ${order?._id}:`, error)
    return false
  }
}

/**
 * Notify kitchen about order status update
 * @param {object} io - Socket.IO server instance
 * @param {object} order - The updated order (mongoose document expected)
 * @param {string} previousStatus - Previous order status
 */
export const notifyKitchenAboutOrderUpdate = async (io, order, previousStatus) => {
  try {
    // Get kitchen socket ID from Redis
    const kitchenSocketId = await getValue(KITCHEN_SOCKET_KEY)
    
    if (!kitchenSocketId) {
      logger.warn("No kitchen app registered, cannot notify about order update")
      return false
    }
    
    // Format order update for kitchen display
    const orderUpdate = {
      id: order._id.toString(),
      orderNumber: order._id.toString().slice(-6).toUpperCase(),
      status: order.status,
      previousStatus, // Send previous status for client logic
      updatedAt: order.updatedAt || new Date(), // Use order updatedAt if available
    }
    
    // Emit event directly to kitchen socket
    io.to(kitchenSocketId).emit("order_status_updated", orderUpdate)

    // Invalidate kitchen orders cache *after* successful emission
    await deleteCache(KITCHEN_ORDERS_CACHE)
    
    logger.info(`Notified kitchen (${kitchenSocketId}) about order update: ${order._id} (${previousStatus} -> ${order.status})`)
    return true
  } catch (error) {
    logger.error(`Error notifying kitchen about order update ${order?._id}:`, error)
    return false
  }
}
