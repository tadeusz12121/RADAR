import express from 'express';
import mongoose from 'mongoose';
import fs from 'fs';
const app = express();
app.use(express.static('public'));
let i = 0;
let aircrafts = []
function readplanes() {
    
    fs.readFile('history_3.json', function(err, data) { 

    if (err) throw err; 
    i = i + 1;
    aircrafts = JSON.parse(data); 
    console.log(aircrafts); 
    
    console.log(i)
    
}); 


    }setInterval(readplanes, 1500);

readplanes();
app.get("/",(req, res) => {
    
    res.json(aircrafts)    
})
app.get('/api/planes', (req, res) => {
    res.json(aircrafts);
});
app.listen(8080);