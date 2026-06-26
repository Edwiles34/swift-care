import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getFunctions } from "firebase/functions";
const firebaseConfig = {
  apiKey:            "AIzaSyCWAEzL_41qvlq_PFAK1yZy-kc_W-Z66yc",
  authDomain:        "swiftcare-26073.firebaseapp.com",
  projectId:         "swiftcare-26073",
  storageBucket:     "swiftcare-26073.firebasestorage.app",
  messagingSenderId: "205955009932",
  appId:             "1:205955009932:web:748c297eeecaeef0eb1aa9",
};
const app = initializeApp(firebaseConfig);
export const auth      = getAuth(app);
export const db        = getFirestore(app);
export const storage   = getStorage(app);
export const functions = getFunctions(app);
