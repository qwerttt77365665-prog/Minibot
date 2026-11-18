const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');

// ==========================================
// ১. ফায়ারবেস ও টেলিগ্রাম কনফিগারেশন
// ==========================================

// আপনার ফায়ারবেস রিয়েলটাইম ডাটাবেস ইউআরএল
const FIREBASE_DB_URL = "https://telegram-mini-bot-7e19a-default-rtdb.firebaseio.com";

// আপনার আসল টেলিগ্রাম বট টোকেনটি এখানে বসান
const BOT_TOKEN = '9027022496:AAGPfvHnBntgbK-ejEpN_QJ0umW1AOPrSRM'; 

// ফায়ারবেস ইনিশিয়ালাইজেশন (হোস্টিং এনভায়রনমেন্টের জন্য ডিরেক্ট ডাটাবেস কানেকশন)
try {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      databaseURL: FIREBASE_DB_URL
    });
} catch (e) {
    // যদি ডিফল্ট ক্রডেনশিয়াল না থাকে তবে রিয়েলটাইম ডাটাবেস ইউআরএল দিয়ে কানেক্ট করবে
    admin.initializeApp({
      databaseURL: FIREBASE_DB_URL
    });
}

const db = admin.database();
const bot = new Telegraf(BOT_TOKEN);

// ==========================================
// ২. টাস্ক ভেরিফিকেশন ও অটোমেশন লজিক
// ==========================================

bot.start(async (ctx) => {
    const text = ctx.message.text; // যেমন: /start verify_task123
    const chatId = ctx.chat.id;
    const userId = String(ctx.from.id);

    // যদি ইউজার মিনি অ্যাপ থেকে ভেরিফাই করতে আসে
    if (text && text.startsWith('/start verify_')) {
        const taskId = text.split('_')[1];

        try {
            // ফায়ারবেস থেকে টাস্কের তথ্য আনা
            const taskSnap = await db.ref(`tasks/${taskId}`).once('value');
            if (!taskSnap.exists()) {
                await ctx.reply("❌ দুঃখিত, এই টাস্কটি পাওয়া যায়নি বা মেয়াদ শেষ হয়ে গেছে।");
                return;
            }
            
            const task = taskSnap.val();
            let channelUsername = task.link;
            
            // চ্যানেলের ইউজারনেম বা লিংক ফরম্যাট ঠিক করা
            if (channelUsername && channelUsername.includes('t.me/')) {
                channelUsername = '@' + channelUsername.split('t.me/')[1].split('/')[0];
            }

            if (!channelUsername) {
                await ctx.reply("❌ এই টাস্কের কোনো সঠিক চ্যানেল লিংক পাওয়া যায়নি।");
                return;
            }

            // টেলিগ্রাম API দিয়ে রিয়েল চেক করা ইউজার চ্যানেলে জয়েন করেছে কি না
            // (বটটিকে অবশ্যই সংশ্লিষ্ট চ্যানেলের অ্যাডমিন হতে হবে)
            const chatMember = await bot.telegram.getChatMember(channelUsername, userId);
            const status = chatMember.status;

            if (!['member', 'administrator', 'creator'].includes(status)) {
                await ctx.reply(`❌ আপনি এখনো "${task.title || 'চ্যানেল'}"-এ জয়েন করেননি!\n\nদয়া করে চ্যানেলটিতে জয়েন করে আবার মিনি অ্যাপে গিয়ে 'ভেরিফাই ও ক্লেইম' করুন।`);
                return;
            }

            // ফায়ারবেস থেকে ইউজারের ডাটা চেক করা
            const userRef = db.ref(`users/${userId}`);
            const userSnap = await userRef.once('value');
            if (!userSnap.exists()) {
                await ctx.reply("❌ আগে মিনি অ্যাপে প্রবেশ করে আপনার অ্যাকাউন্ট রেজিস্টার করুন!");
                return;
            }
            const userData = userSnap.val();

            // চেক করা ইউজার ইতিমধ্যে এই টাস্কের রিওয়ার্ড নিয়েছে কি না
            if (userData.completedTasks && userData.completedTasks[taskId]) {
                await ctx.reply("✅ আপনি এই টাস্কটির রিওয়ার্ড ইতিমধ্যে নিয়ে ফেলেছেন!");
                return;
            }

            // ব্যালেন্স ও টাস্ক কাউন্ট আপডেট করার প্রস্তুতি
            const reward = Number(task.reward || 0);
            const newBalance = Number(userData.balance || 0) + reward;
            const newTaskCount = Number(userData.tasksCompletedCount || 0) + 1;

            const updates = {};
            updates[`users/${userId}/balance`] = newBalance;
            updates[`users/${userId}/tasksCompletedCount`] = newTaskCount;
            updates[`users/${userId}/completedTasks/${taskId}`] = true;
            updates[`tasks/${taskId}/completedCount`] = Number(task.completedCount || 0) + 1;

            // ইউজারের নোটিফিকেশন লিস্টে মেসেজ যোগ করা
            const notifKey = db.ref(`users/${userId}/notifications`).push().key;
            updates[`users/${userId}/notifications/${notifKey}`] = {
                title: `টাস্ক সম্পন্ন: ${task.title || 'VIP Task'}`,
                message: `চ্যানেল জয়েন ভেরিফাইড! আপনি +৳${reward.toFixed(2)} রিওয়ার্ড পেয়েছেন।`,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };

            // রেফারেল রুল চেক: ইউজারের সব টাস্ক সম্পন্ন হলে তবেই রেফারার বোনাস পাবে
            const allTasksSnap = await db.ref('tasks').once('value');
            const totalAdminTasksCount = allTasksSnap.numChildren();

            if (newTaskCount >= totalAdminTasksCount && userData.referredBy && !userData.referralVerified) {
                updates[`users/${userId}/referralVerified`] = true;
                const inviterSnap = await db.ref(`users/${userData.referredBy}`).once('value');
                if (inviterSnap.exists()) {
                    const inviter = inviterSnap.val();
                    const refBonus = 5; // অ্যাডমিন নির্ধারিত রেফার বোনাস
                    updates[`users/${userData.referredBy}/balance`] = Number(inviter.balance || 0) + refBonus;
                    updates[`users/${userData.referredBy}/referralsCount`] = Number(inviter.referralsCount || 0) + 1;
                }
            }

            // ফায়ারবেসে একসাথে সব আপডেট সেভ করা
            await db.ref().update(updates);

            // সফল মেসেজ পাঠানো
            await ctx.reply(`🎉 অভিনন্দন! আপনার ভেরিফিকেশন সফল হয়েছে।\n💰 আপনার অ্যাকাউন্টে +৳${reward.toFixed(2)} যোগ করা হয়েছে।\n\nএখন মিনি অ্যাপে গিয়ে আপনার ব্যালেন্স চেক করতে পারেন।`);

        } catch (error) {
            console.error("Verification Error:", error.message);
            await ctx.reply("⚠️ ভেরিফিকেশন করতে সমস্যা হয়েছে। দয়া করে নিশ্চিত করুন যে বটটিকে সংশ্লিষ্ট চ্যানেলের অ্যাডমিন (Administrator) করা হয়েছে।");
        }
    } else {
        // সাধারণ স্টার্ট কমান্ডের জন্য ওয়েলকাম মেসেজ
        await ctx.reply("🌸 আসসালামু আলাইকুম! VIP TASK বটে আপনাকে স্বাগতম। টাস্ক কমপ্লিট করে আয় করতে মিনি অ্যাপ ওপেন করুন।");
    }
});

// বট চালু করা
bot.launch();
console.log('Telegram Bot & Verification Automation is running successfully...');

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
