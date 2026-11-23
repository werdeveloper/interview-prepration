function greet(city){
    console.log(`My name is ${this.name} and age is ${city}`)
}

let person = {
    name: "Deep",
    age: 30
}

greet(person, "Delhi"); // Not Working

greet.call(person, "Delhi"); // Working (call)

greet.apply(person, ["Delhi"]); // Working (apply)

let callFun = greet.bind(person, "Delhi"); // Working (bind)
callFun();
