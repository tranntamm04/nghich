const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bcrypt = require("bcrypt");
const bodyParser = require("body-parser");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Phục vụ file tĩnh từ thư mục frontend
app.use(express.static(path.join(__dirname, "../frontend")));
app.use("/sounds", express.static(path.join(__dirname, "../sounds")));

// Route mặc định
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/tx.html"));
});

// Database connection
const dbConfig = {
  host: "localhost",
  user: "root",
  password: "123456",
  database: "tx",
};

// Kết nối database
let db;
async function connectDB() {
  try {
    db = await mysql.createConnection(dbConfig);
    console.log("Kết nối MySQL thành công!");
  } catch (error) {
    console.error("Lỗi kết nối MySQL:", error);
  }
}

// WebSocket cho chat realtime
const clients = new Map();

wss.on("connection", (ws) => {
  console.log("Client connected");

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === "login") {
        // Lưu thông tin user khi login
        clients.set(ws, {
          userId: data.userId,
          username: data.username,
        });

        // Gửi danh sách user online
        broadcastUserList();

        // Thông báo user mới tham gia
        broadcastMessage({
          type: "user_join",
          username: data.username,
          message: `${data.username} đã tham gia phòng chat`,
          timestamp: new Date().toISOString(),
        });
      } else if (data.type === "chat_message") {
        // Broadcast tin nhắn đến tất cả clients
        broadcastMessage({
          type: "chat_message",
          username: data.username,
          message: data.message,
          timestamp: new Date().toISOString(),
        });
      } else if (data.type === "game_result") {
        // Broadcast kết quả game
        broadcastMessage({
          type: "game_result",
          username: data.username,
          message: data.message,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error("Lỗi xử lý WebSocket message:", error);
    }
  });

  ws.on("close", () => {
    const userInfo = clients.get(ws);
    if (userInfo) {
      // Thông báo user rời đi
      broadcastMessage({
        type: "user_leave",
        username: userInfo.username,
        message: `${userInfo.username} đã rời khỏi phòng chat`,
        timestamp: new Date().toISOString(),
      });

      clients.delete(ws);
      broadcastUserList();
    }
    console.log("Client disconnected");
  });
});

// Broadcast tin nhắn đến tất cả clients
function broadcastMessage(message) {
  const data = JSON.stringify(message);
  clients.forEach((userInfo, client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// Broadcast danh sách user online
function broadcastUserList() {
  const users = Array.from(clients.values()).map((user) => ({
    username: user.username,
    userId: user.userId,
  }));

  const userListMessage = {
    type: "user_list",
    users: users,
  };

  broadcastMessage(userListMessage);
}

// API Routes

// Đăng nhập
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const [rows] = await db.execute("SELECT * FROM users WHERE username = ?", [
      username,
    ]);

    if (rows.length === 0) {
      return res.status(401).json({ error: "Tài khoản không tồn tại" });
    }

    const user = rows[0];
    if (password === user.password) {
      res.json({
        success: true,
        user: {
          id: user.id,
          username: user.username,
          balance: user.balance,
        },
      });
    } else {
      res.status(401).json({ error: "Sai mật khẩu" });
    }
  } catch (error) {
    res.status(500).json({ error: "Lỗi server" });
  }
});
// API Đăng ký
app.post("/api/register", async (req, res) => {
  try {
    const { username, password } = req.body;

    // Kiểm tra username đã tồn tại chưa
    const [existingUsers] = await db.execute(
      "SELECT * FROM users WHERE username = ?",
      [username]
    );

    if (existingUsers.length > 0) {
      return res.status(400).json({ error: "Tên đăng nhập đã tồn tại" });
    }

    // Tạo user mới
    await db.execute(
      "INSERT INTO users (username, password, balance) VALUES (?, ?, ?)",
      [username, password, 100000] // Số dư mặc định 100,000 VNĐ
    );

    res.json({
      success: true,
      message: "Đăng ký thành công!",
    });
  } catch (error) {
    console.error("Lỗi đăng ký:", error);
    res.status(500).json({ error: "Lỗi server" });
  }
});
// API Thống kê lịch sử
// API Thống kê lịch sử
app.get("/api/stats/:userId", async (req, res) => {
  try {
    const [stats] = await db.execute(
      `SELECT 
          COUNT(*) as totalGames,
          SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN result = 'lose' THEN 1 ELSE 0 END) as losses,
          COALESCE(SUM(CASE WHEN result = 'win' THEN bet_amount ELSE -bet_amount END), 0) as totalProfit
       FROM game_history 
       WHERE user_id = ?`,
      [req.params.userId]
    );

    // Debug: log kết quả để kiểm tra
    console.log("Stats result:", stats[0]);
    console.log("User ID:", req.params.userId);

    res.json({
      success: true,
      stats: stats[0],
    });
  } catch (error) {
    console.error("Lỗi API stats:", error);
    res.status(500).json({ error: "Lỗi server" });
  }
});
// API Nạp/Rút tiền
app.post("/api/transaction", async (req, res) => {
  try {
    const { userId, type, amount, description } = req.body;

    // Kiểm tra user
    const [userRows] = await db.execute(
      "SELECT balance FROM users WHERE id = ?",
      [userId]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: "User không tồn tại" });
    }

    const currentBalance = parseFloat(userRows[0].balance);
    let newBalance;

    if (type === "deposit") {
      newBalance = currentBalance + parseFloat(amount);
    } else if (type === "withdraw") {
      if (currentBalance < amount) {
        return res.status(400).json({ error: "Số dư không đủ" });
      }
      newBalance = currentBalance - parseFloat(amount);
    } else {
      return res.status(400).json({ error: "Loại giao dịch không hợp lệ" });
    }

    // Cập nhật số dư
    await db.execute("UPDATE users SET balance = ? WHERE id = ?", [
      newBalance,
      userId,
    ]);

    // Lưu lịch sử giao dịch (cần tạo bảng transaction_history)
    await db.execute(
      `INSERT INTO transaction_history 
             (user_id, type, amount, description, balance_after) 
             VALUES (?, ?, ?, ?, ?)`,
      [userId, type, amount, description, newBalance]
    );

    res.json({
      success: true,
      newBalance: newBalance,
      message:
        type === "deposit" ? "Nạp tiền thành công" : "Rút tiền thành công",
    });
  } catch (error) {
    console.error("Lỗi giao dịch:", error);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// Lấy lịch sử game
app.get("/api/history/:userId", async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT * FROM game_history 
             WHERE user_id = ? 
             ORDER BY created_at DESC 
             LIMIT 10`,
      [req.params.userId]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: "Lỗi server" });
  }
});

// Chơi game
app.post("/api/play", async (req, res) => {
  try {
    const { userId, betType, betAmount } = req.body;

    // Kiểm tra số dư
    const [userRows] = await db.execute(
      "SELECT balance FROM users WHERE id = ?",
      [userId]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: "User không tồn tại" });
    }

    const currentBalance = parseFloat(userRows[0].balance);

    if (currentBalance < betAmount) {
      return res.status(400).json({ error: "Không đủ số dư" });
    }

    // Lắc xúc xắc
    const dice1 = Math.floor(Math.random() * 6) + 1;
    const dice2 = Math.floor(Math.random() * 6) + 1;
    const dice3 = Math.floor(Math.random() * 6) + 1;
    const total = dice1 + dice2 + dice3;

    // Xác định kết quả
    const result = total >= 4 && total <= 10 ? "small" : "big";
    const isWin = betType === result;

    // Tính toán số dư mới
    let newBalance;
    if (isWin) {
      newBalance = currentBalance + parseFloat(betAmount);
    } else {
      newBalance = currentBalance - parseFloat(betAmount);
    }

    // Cập nhật database
    await db.execute("UPDATE users SET balance = ? WHERE id = ?", [
      newBalance,
      userId,
    ]);

    // Lưu lịch sử game
    await db.execute(
      `INSERT INTO game_history 
             (user_id, bet_type, bet_amount, dice1, dice2, dice3, total, result) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        betType,
        betAmount,
        dice1,
        dice2,
        dice3,
        total,
        isWin ? "win" : "lose",
      ]
    );

    res.json({
      success: true,
      dice: [dice1, dice2, dice3],
      total: total,
      result: result,
      isWin: isWin,
      newBalance: newBalance,
      winAmount: isWin ? betAmount : 0,
    });
  } catch (error) {
    console.error("Lỗi khi chơi game:", error);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// Khởi động server
server.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
  connectDB();
});
